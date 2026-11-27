// The knowledge layer.
//
// Plain-language security knowledge, placed where it is useful:
//   - a library of exploit classes (what goes wrong, why, what to check)
//   - protocol-type playbooks that pick the usual suspects for a target type
//   - per-component checklists derived from the playbook
//   - a suggestions engine that proposes where to look next
//   - an agent briefing that hands agents the same context so they stay proactive

import crypto from 'node:crypto';
import { ENUMS, isReviewable } from './model.js';

// ---------- exploit class library ----------

export const CLASSES = {
  reentrancy: {
    name: 'Reentrancy',
    plain: 'A contract calls out to someone else before it finishes updating its own books, and that someone calls back in while the books are still wrong.',
    deeper: 'Look for external calls (token transfers, callbacks, hooks like ERC777/ERC721 onReceived, raw .call) that happen before state is updated. Cross-function and read-only reentrancy count too: another function, or a view used by a different protocol, can observe the half-updated state.',
    checks: [
      'State is updated before every external call (checks-effects-interactions)',
      'Functions sharing state are guarded together, not just individually',
      'View functions used for pricing cannot be read mid-update (read-only reentrancy)',
      'Token hooks (ERC777, ERC721/1155 receivers) cannot re-enter',
    ],
  },
  'access-control': {
    name: 'Access control',
    plain: 'Someone can call a function they should not be able to, like an admin-only setter or a mint.',
    deeper: 'Enumerate every state-changing function and ask who can call it. Watch for missing modifiers, wrong modifiers, roles granted at init to the wrong address, tx.origin checks, and functions that are internal in spirit but public in code.',
    checks: [
      'Every state-changing function has the intended caller restriction',
      'Role assignment and revocation paths are themselves protected',
      'No tx.origin-based authorization',
      'Initializer cannot be called twice or by anyone',
    ],
  },
  'oracle-manipulation': {
    name: 'Oracle manipulation',
    plain: 'The protocol trusts a price that an attacker can push around, usually within one transaction.',
    deeper: 'Spot prices from AMM reserves, balanceOf-based pricing, and thin-liquidity TWAPs can all be moved with borrowed capital. Check what source each price comes from, how long its averaging window is, and what an attacker gains by skewing it for one block.',
    checks: [
      'No price derived from spot AMM reserves or raw balanceOf',
      'TWAP windows are long enough for the pool liquidity',
      'Price deviation or circuit-breaker checks exist',
      'Cost to move the price vs. profit from moving it is estimated',
    ],
  },
  'stale-price': {
    name: 'Stale or invalid price',
    plain: 'The protocol keeps using a price after it stopped being true, or accepts a zero or negative price.',
    deeper: 'Chainlink-style feeds need freshness checks (updatedAt), round completeness, min/max answer bounds, and on L2s a sequencer-uptime check. Fallback oracles need the same scrutiny as the primary.',
    checks: [
      'updatedAt is checked against a heartbeat',
      'Answer <= 0 is rejected',
      'L2 sequencer uptime feed is consulted where relevant',
      'Fallback oracle path is validated too',
    ],
  },
  'flash-loan': {
    name: 'Flash-loan amplified attacks',
    plain: 'Anyone can borrow a huge amount for one transaction, so any logic that assumes "nobody has that much money" is breakable.',
    deeper: 'Flash loans are a capital multiplier, not a bug by themselves. Combine with: governance voting on current balance, spot-price oracles, reward snapshots on current balance, or donation-based share inflation.',
    checks: [
      'No decision depends on a balance that can be borrowed and returned in one tx',
      'Voting power and rewards use checkpoints from earlier blocks',
      'Large single-tx deposit/withdraw cycles cannot skim value',
    ],
  },
  rounding: {
    name: 'Rounding and precision',
    plain: 'Integer math drops fractions. If the protocol rounds in the user\'s favor, someone can repeat it many times and drain the difference.',
    deeper: 'Every division should round against the user (down on what they receive, up on what they owe). Watch multiply-after-divide, mismatched decimals, and tiny amounts that round to zero fees or zero shares.',
    checks: [
      'Division rounds in the protocol\'s favor on both deposit and withdraw',
      'Multiplication happens before division',
      'Dust amounts cannot round fees or debt to zero',
      'Token decimals are normalized consistently',
    ],
  },
  'share-inflation': {
    name: 'Share inflation (first depositor)',
    plain: 'The first depositor can donate tokens to make one share worth a fortune, so the next depositor\'s deposit rounds down to zero shares.',
    deeper: 'Classic ERC-4626 issue. Mitigations: virtual shares/assets offset, dead shares minted at init, minimum first deposit, or internal accounting that ignores donations.',
    checks: [
      'Empty-vault first deposit is protected (virtual offset or dead shares)',
      'totalAssets cannot be inflated by direct transfers',
      'Deposit reverts or mints nonzero shares for any nonzero deposit',
    ],
  },
  'interest-accounting': {
    name: 'Interest and index accounting',
    plain: 'Interest is added up over time. If it is updated in the wrong order, someone can borrow or withdraw at an out-of-date rate.',
    deeper: 'Every function that reads balances or debt must accrue interest first. Check index updates on borrow, repay, liquidate, and rate-model changes, and whether accrual can overflow or be skipped.',
    checks: [
      'Interest accrues before any balance or debt read',
      'Rate model changes accrue at the old rate first',
      'Reserve factor and protocol fees are applied once',
    ],
  },
  liquidation: {
    name: 'Liquidation logic',
    plain: 'When a loan goes bad it must be closable by someone, at a fair price. Bugs here leave bad debt or let liquidators steal.',
    deeper: 'Check health-factor math, the liquidation bonus vs. close factor, what happens with dust positions, whether liquidation can be blocked (paused token, reverting hook, blacklist), and self-liquidation profitability.',
    checks: [
      'Health factor uses the same prices and decimals as borrowing',
      'Liquidation cannot be blocked by the borrower',
      'Small positions are still worth liquidating (no unliquidatable dust)',
      'Bonus cannot exceed the collateral, leaving bad debt',
    ],
  },
  'slippage-mev': {
    name: 'Slippage and MEV',
    plain: 'A trade that does not say "I will accept at worst this price" can be sandwiched: a bot moves the price before and after you.',
    deeper: 'User-facing swaps, deposits that swap internally, and harvest/compound functions need minOut and deadline parameters. Protocol-owned swaps triggered by anyone are a common MEV leak.',
    checks: [
      'Every swap path has a user-set minimum output',
      'Deadlines are enforced and not set to block.timestamp',
      'Keeper or harvest swaps are not sandwichable for profit',
    ],
  },
  invariant: {
    name: 'Broken pool invariant',
    plain: 'An AMM promises a rule like x * y = k. If any path lets that number drop, liquidity providers lose money.',
    deeper: 'Check every path that changes reserves: swaps, add/remove liquidity, fee collection, skim/sync, flash swaps. Check fee application order and whether k is checked after callbacks.',
    checks: [
      'Invariant is checked after every reserve change including callbacks',
      'Fees are applied before the invariant check',
      'skim/sync or donations cannot break accounting',
    ],
  },
  'weird-tokens': {
    name: 'Non-standard tokens',
    plain: 'Some tokens take a fee on transfer, change balances on their own, or do not return true. Code that assumes "I sent 100 so they got 100" breaks.',
    deeper: 'Fee-on-transfer, rebasing, ERC777 hooks, tokens without return values (USDT), pausable/blacklisting tokens, and tokens with unusual decimals. Measure balance before/after where amounts matter, and use safe transfer wrappers.',
    checks: [
      'Received amount is measured, not assumed, where fee-on-transfer is possible',
      'SafeERC20 (or equivalent) is used for transfers and approvals',
      'Rebasing tokens are either supported or explicitly excluded',
      'Decimals are read, not hardcoded',
    ],
  },
  'signature-replay': {
    name: 'Signature replay',
    plain: 'A signed permission can be reused: on another chain, another contract, or simply twice.',
    deeper: 'Signatures need a nonce, a deadline, the chain id, and the verifying contract (EIP-712 domain). Watch ecrecover returning address(0), malleable signatures, and cancelled orders that still validate.',
    checks: [
      'Signed messages include nonce, deadline, chainId and verifying contract',
      'Nonces are consumed before effects',
      'ecrecover zero address is rejected; malleability handled',
    ],
  },
  'message-validation': {
    name: 'Cross-chain message validation',
    plain: 'A bridge acts on a message saying "this was sent on the other chain". If it does not check where the message really came from, anyone can forge one.',
    deeper: 'Check source-chain and source-sender validation, that the relayer/endpoint is the only caller, that messages cannot be replayed or executed twice, and that a failed message can be retried without double-spend.',
    checks: [
      'Receiver checks the trusted endpoint as msg.sender',
      'Source chain and source contract are validated',
      'Each message id executes at most once',
      'Failed messages can be retried safely',
    ],
  },
  finality: {
    name: 'Finality and reorgs',
    plain: 'A bridge that acts before the source chain is sure can be tricked by a reorg: the deposit disappears but the mint stays.',
    deeper: 'Confirmation counts per chain, optimistic windows and challenge periods, and what the system does when the source chain reorganizes.',
    checks: [
      'Confirmations match the source chain\'s finality',
      'Challenge windows cannot be skipped',
    ],
  },
  upgradeability: {
    name: 'Upgrades and proxies',
    plain: 'Upgradeable contracts can be taken over if the implementation is left uninitialized, or corrupted if storage slots shift.',
    deeper: 'Check that implementations call _disableInitializers, storage layout is append-only with gaps, upgrade authorization is protected, and selfdestruct/delegatecall cannot brick the implementation.',
    checks: [
      'Implementation contract cannot be initialized by anyone',
      'Storage layout is compatible across versions',
      'Upgrade function is restricted and timelocked',
    ],
  },
  'governance-takeover': {
    name: 'Governance takeover',
    plain: 'If votes can be bought or borrowed for one block, an attacker can pass a proposal that hands them the treasury.',
    deeper: 'Check voting power snapshots, quorum math, proposal thresholds, execution delay, and whether proposals can call arbitrary targets.',
    checks: [
      'Voting power is snapshotted at proposal creation',
      'Quorum cannot be met with flash-loaned tokens',
      'Execution has a delay and cannot be front-run with a new proposal',
    ],
  },
  timelock: {
    name: 'Timelock and admin bypass',
    plain: 'A timelock gives users time to leave before a risky change. A side door around it removes that protection.',
    deeper: 'Look for emergency functions, guardian roles, or parameter setters that are not behind the timelock, and for timelocks with zero minimum delay.',
    checks: [
      'All sensitive setters go through the timelock',
      'Emergency roles are limited to pausing, not moving funds',
    ],
  },
  'funding-rate': {
    name: 'Funding rate and skew',
    plain: 'Perps balance longs and shorts with funding payments. Bad funding math lets one side drain the other or the protocol.',
    deeper: 'Check funding accrual timing, skew caps, rounding, and whether funding can be settled selectively by the profitable side.',
    checks: [
      'Funding accrues before position changes',
      'Funding cannot be settled only when profitable',
    ],
  },
  'margin-accounting': {
    name: 'Margin and PnL accounting',
    plain: 'Positions track collateral, profit and loss. A mismatch can let a trader withdraw more than they own.',
    deeper: 'Check PnL realization, fee deduction order, collateral withdraw checks against unrealized loss, and position-size limits vs. open interest caps.',
    checks: [
      'Withdrawals account for unrealized losses',
      'Fees are deducted before margin checks',
      'Open-interest caps are enforced on every increase',
    ],
  },
  'reward-accounting': {
    name: 'Reward accounting',
    plain: 'Staking rewards are split by time and stake. If the split is updated in the wrong order, late stakers can claim early rewards.',
    deeper: 'Check rewardPerToken updates on stake/unstake/claim, reward rate changes mid-period, and dilution by zero-duration stakes.',
    checks: [
      'Reward state updates before every balance change',
      'Changing the reward rate does not misallocate past rewards',
      'Stake-claim-unstake in one block earns nothing extra',
    ],
  },
  'withdrawal-queue': {
    name: 'Withdrawals and unbonding',
    plain: 'Staked funds often leave through a queue. Bugs let people skip the line, withdraw twice, or get stuck forever.',
    deeper: 'Check request ids, exchange rate at request vs. claim time, slashing during unbonding, and whether the queue can be griefed with tiny requests.',
    checks: [
      'Exchange rate locked at the right moment',
      'Each request is claimable once',
      'Queue cannot be griefed with dust requests',
    ],
  },
  slashing: {
    name: 'Slashing',
    plain: 'If a validator misbehaves, stakers lose a cut. The loss has to be shared fairly and cannot be dodged by leaving at the right time.',
    deeper: 'Check that slashing applies to pending withdrawals, that the share price updates atomically, and that front-running a slash is not profitable.',
    checks: [
      'Pending withdrawals share in slashing',
      'Exiting just before a slash is not profitable',
    ],
  },
  'order-validation': {
    name: 'Order and listing validation',
    plain: 'Marketplaces match signed orders. If an order can be filled twice, with the wrong item, or after cancellation, users lose NFTs or funds.',
    deeper: 'Check order hashing completeness, cancellation and nonce invalidation, partial fills, royalty and fee math, and approvals that outlive the order.',
    checks: [
      'Order hash covers every field that matters',
      'Cancelled or filled orders cannot be filled again',
      'Fees and royalties cannot exceed the price',
    ],
  },
  'arbitrary-call': {
    name: 'Arbitrary external calls',
    plain: 'A function that calls whatever address and data the user supplies can be pointed at a token to spend someone else\'s approvals.',
    deeper: 'Routers, multicall, and zap contracts often hold approvals. Check that target and calldata are restricted, and that the contract never holds standing approvals from users beyond one tx.',
    checks: [
      'User-supplied call targets are allowlisted',
      'Contract cannot be used to spend users\' standing approvals',
    ],
  },
  'dos-gas': {
    name: 'Denial of service',
    plain: 'Something important can be made to always fail: a loop that grows forever, or one reverting party that blocks everyone.',
    deeper: 'Unbounded loops over user-controlled arrays, push-payments to addresses that revert, and griefing through dust deposits or blocked transfers.',
    checks: [
      'No unbounded loops over user-growable data',
      'Payments use pull, not push',
      'One user cannot block others\' withdrawals',
    ],
  },
  'supply-control': {
    name: 'Mint and supply control',
    plain: 'If anyone can mint, or burn other people\'s tokens, the token is worthless.',
    deeper: 'Check mint/burn authorization, supply caps, permit implementation, and allowance edge cases (infinite approvals, approve race).',
    checks: [
      'Mint and burn are restricted',
      'Supply caps hold on every mint path',
      'permit is EIP-2612 compliant with nonces',
    ],
  },
  'factory-auth': {
    name: 'Factory privileges',
    plain: 'A factory that deploys contracts often keeps powers over them: roles, operator approvals, ownership. If any public path makes the factory use those powers, everything it deployed is at risk.',
    deeper: 'List every role, approval and ownership the factory holds over what it deploys (MINTER_ROLE, ENS operator, Safe owner). Then hunt the trigger: a callback, multicall payload or public function that makes the factory issue the privileged call. A power with no trigger is a capability, not a bug.',
    checks: [
      'Every power the factory keeps over deployed contracts is listed',
      'No public function, callback or forwarded calldata makes the factory use those powers',
      'Deployed contracts cannot be initialized or re-initialized by anyone else',
    ],
  },
  'leftover-roles': {
    name: 'Leftover roles',
    plain: 'Roles granted during deployment and never renounced. They look harmless until the holder can be made to act, or its key leaks.',
    deeper: 'Diff granted roles against intended roles after deploy: deployer, factory, migration helpers, test accounts. Check whether renounce happened on-chain, not just in the script.',
    checks: [
      'Roles held on-chain match the documented intent',
      'Deployer and helper roles were renounced on-chain',
      'Each remaining privileged holder is a contract with no external trigger, or a key the team controls',
    ],
  },
  initializer: {
    name: 'Initialization',
    plain: 'Contracts deployed as clones or proxies are set up by an initialize call. If someone else gets there first, or can call it twice, they own it.',
    deeper: 'Check that initialize is called atomically with deployment, protected against re-entry, and that implementation contracts are locked.',
    checks: [
      'initialize runs in the same transaction as deployment',
      'initialize cannot be called twice',
      'The implementation contract is locked',
    ],
  },
  'module-config': {
    name: 'Safe / Zodiac module wiring',
    plain: 'DAOs built on Safe modules depend on how the modules are wired: who the owner is, cooldowns and timeouts, which oracle or arbitrator decides. A weak setting can let someone pass a transaction the members never approved.',
    deeper: 'For each module: owner (a dead owner is good, an EOA is not), cooldown and expiration, bond sizes, arbitrator, question template, and whether the module can be disabled or replaced by itself.',
    checks: [
      'Module owner is dead or a trusted contract, not an EOA',
      'Cooldown and expiration give members time to react',
      'Bonds are high enough that a wrong answer is costly',
      'Nothing lets a module re-enable, replace or bypass itself',
    ],
  },
  'reality-oracle': {
    name: 'Reality.eth answers',
    plain: 'Reality.eth decides proposals by bonded answers. With a tiny bond, a short timeout or a weak arbitrator, a false answer can win.',
    deeper: 'Check the minimum bond, the timeout, the arbitrator (and whether it is set at all), the question template, and whether answers on stale or malformed questions are executed.',
    checks: [
      'Minimum bond is meaningful relative to what an answer can move',
      'Arbitrator is set and trustworthy',
      'Question text binds the exact transaction to execute',
    ],
  },
  'ens-operator': {
    name: 'ENS names and operators',
    plain: 'ENS approvals and subdomains can be squatted or reassigned. An operator approval over a parent name gives power over every subname.',
    deeper: 'Check operator approvals on parent names, who can create or overwrite subnames, resolver records (setAddr) that point users somewhere else, and NameWrapper fuses.',
    checks: [
      'Operators over parent names are known and have no external trigger',
      'Unused subname labels cannot be claimed by strangers',
      'Resolver records cannot be redirected by strangers',
    ],
  },
  'nft-custody': {
    name: 'NFT custody',
    plain: 'Vaults and DAOs that hold NFTs must only release them on the right path. Sweep functions, receive hooks and transfers out are where they leak.',
    deeper: 'Map every path an NFT can leave custody: sweeps, rescues, buyouts, module transactions. Check onERC721Received for side effects and reentrancy.',
    checks: [
      'Every path an NFT can leave custody is listed and gated',
      'Sweep and rescue functions cannot take custodied NFTs',
      'onERC721Received has no exploitable side effects',
    ],
  },
  'buyout-accounting': {
    name: 'Buyout and redemption accounting',
    plain: 'Buyouts and redemptions split proceeds among holders. Errors let someone redeem twice, redeem at the wrong price, or strand funds.',
    deeper: 'Follow proceeds from buyout to every holder: pricing, partial fills, refunds, and what happens to tokens transferred mid-buyout.',
    checks: [
      'Each holder can redeem once, at the right price',
      'Failed or cancelled buyouts refund correctly',
      'Transfers during a buyout cannot double-count',
    ],
  },
};

// ---------- playbooks ----------

export const PLAYBOOKS = {
  lending: {
    name: 'Lending / borrowing',
    summary: 'Users deposit collateral and borrow against it. Money is lost when prices lie, interest is counted wrong, or bad loans cannot be closed.',
    startHere: 'Start with how collateral is priced, then follow a borrow and a liquidation end to end.',
    classes: ['oracle-manipulation', 'stale-price', 'liquidation', 'interest-accounting', 'rounding', 'share-inflation', 'reentrancy', 'weird-tokens', 'access-control'],
  },
  amm: {
    name: 'AMM / DEX',
    summary: 'A pool holds two or more tokens and prices trades by a formula. Money is lost when the formula can be broken or trades can be sandwiched.',
    startHere: 'Start with swap(): where fees are taken and where the invariant is checked.',
    classes: ['invariant', 'rounding', 'slippage-mev', 'reentrancy', 'weird-tokens', 'flash-loan', 'oracle-manipulation', 'access-control'],
  },
  perps: {
    name: 'Perpetuals',
    summary: 'Traders open leveraged long and short positions with no expiry. Money is lost through mispriced margin, funding, or liquidations.',
    startHere: 'Start with how PnL and margin are computed when a position increases and closes.',
    classes: ['margin-accounting', 'funding-rate', 'oracle-manipulation', 'stale-price', 'liquidation', 'rounding', 'slippage-mev', 'access-control'],
  },
  bridge: {
    name: 'Bridge',
    summary: 'Locks assets on one chain and mints or releases them on another. Bridges have lost more money than any other category, usually through forged or replayed messages.',
    startHere: 'Start with the function that receives a cross-chain message and ask: who can call it, and what proves the message is real?',
    classes: ['message-validation', 'signature-replay', 'finality', 'access-control', 'upgradeability', 'weird-tokens', 'reentrancy'],
  },
  staking: {
    name: 'Staking / liquid staking',
    summary: 'Users lock tokens to earn rewards or secure a network. Money is lost when rewards are split wrong or withdrawals can be gamed.',
    startHere: 'Start with how rewards are tracked when someone stakes or unstakes mid-period.',
    classes: ['reward-accounting', 'withdrawal-queue', 'slashing', 'share-inflation', 'rounding', 'flash-loan', 'access-control'],
  },
  'nft-market': {
    name: 'NFT marketplace',
    summary: 'Matches buyers and sellers through signed orders. Money is lost when orders replay, fees misfire, or approvals are abused.',
    startHere: 'Start with how an order is hashed, signed, and invalidated.',
    classes: ['order-validation', 'signature-replay', 'arbitrary-call', 'reentrancy', 'rounding', 'access-control'],
  },
  governance: {
    name: 'Governance',
    summary: 'Token holders vote on changes. Money is lost when votes can be bought for one block or changes skip the delay.',
    startHere: 'Start with when voting power is measured and what an executed proposal is allowed to call.',
    classes: ['governance-takeover', 'flash-loan', 'timelock', 'signature-replay', 'access-control', 'upgradeability'],
  },
  oracle: {
    name: 'Oracle',
    summary: 'Provides prices or data to other protocols. Money is lost downstream when the data is stale, manipulable, or writable by the wrong party.',
    startHere: 'Start with who can push data and how consumers validate it.',
    classes: ['oracle-manipulation', 'stale-price', 'access-control', 'signature-replay', 'flash-loan'],
  },
  token: {
    name: 'Token',
    summary: 'A fungible token with its own rules (fees, rebases, permits). Money is lost through unauthorized mints or broken transfer accounting.',
    startHere: 'Start with every path that changes a balance or the total supply.',
    classes: ['supply-control', 'access-control', 'signature-replay', 'weird-tokens', 'rounding', 'upgradeability'],
  },
  vault: {
    name: 'Vault / yield',
    summary: 'Pools user deposits into strategies and issues shares. Money is lost through share-price manipulation, harvest MEV, or strategy accounting gaps.',
    startHere: 'Start with how shares are minted on the very first deposit, then how a harvest updates totalAssets.',
    classes: ['share-inflation', 'rounding', 'slippage-mev', 'reentrancy', 'oracle-manipulation', 'weird-tokens', 'access-control', 'arbitrary-call'],
  },
  factory: {
    name: 'Factory / deployer',
    summary: 'Deploys and configures other contracts. Money is lost when the factory keeps powers over what it deploys and something can make it use them.',
    startHere: 'List every role, approval and ownership the factory keeps over deployed contracts, then hunt for anything that triggers it.',
    classes: ['factory-auth', 'leftover-roles', 'initializer', 'access-control', 'arbitrary-call', 'upgradeability'],
  },
  'dao-module': {
    name: 'DAO on Safe modules',
    summary: 'A Safe controlled by modules (Zodiac, Reality.eth, governors). Money is lost when module wiring lets a transaction pass that members never approved.',
    startHere: 'For each module, write down owner, cooldown, timeout, bond and arbitrator, then ask what a stranger can push through.',
    classes: ['module-config', 'reality-oracle', 'governance-takeover', 'timelock', 'leftover-roles', 'access-control'],
  },
  'nft-custody': {
    name: 'NFT custody / fractional',
    summary: 'Holds NFTs for a group, often with buyouts or redemptions. Money is lost when NFTs leave custody on an unintended path or proceeds are split wrong.',
    startHere: 'Map every path an NFT can leave custody, then follow buyout proceeds to each holder.',
    classes: ['nft-custody', 'buyout-accounting', 'reentrancy', 'arbitrary-call', 'access-control', 'rounding'],
  },
  naming: {
    name: 'Naming (ENS)',
    summary: 'Issues and manages names. Value is lost when names, subnames or records can be taken or redirected.',
    startHere: 'List operators and owners of every parent name, then who can create subnames and set records.',
    classes: ['ens-operator', 'access-control', 'leftover-roles', 'signature-replay'],
  },
  other: {
    name: 'General',
    summary: 'No specific playbook yet. These classes catch most bugs in most protocols.',
    startHere: 'Start with access control on every state-changing function, then follow the money.',
    classes: ['access-control', 'reentrancy', 'rounding', 'weird-tokens', 'oracle-manipulation', 'dos-gas', 'upgradeability'],
  },
};

// Assumptions developers of each protocol type commonly make. Each one is a prompt:
// does this codebase make it, and does it actually hold?
export const COMMON_ASSUMPTIONS = {
  lending: [
    ['external', 'The price feed is always fresh, positive and correct'],
    ['economic', 'Liquidations are always profitable enough that someone will call them'],
    ['invariant', 'Interest is accrued before any balance or debt is read'],
    ['input', 'Collateral and debt tokens are standard ERC20s with fixed decimals'],
    ['trust', 'Governance will never list a manipulable asset as collateral'],
  ],
  amm: [
    ['invariant', 'The pool invariant (e.g. x*y=k) can only increase after fees'],
    ['input', 'Users always pass a sensible minOut and deadline'],
    ['input', 'Pool tokens do not take fees or rebase'],
    ['external', 'Nobody else reads our spot price as an oracle'],
  ],
  perps: [
    ['external', 'The index price cannot be moved within one block'],
    ['invariant', 'Funding and fees are settled before every position change'],
    ['economic', 'Keepers always liquidate in time, so bad debt never accrues'],
    ['invariant', 'Open interest stays within the caps on every path'],
  ],
  bridge: [
    ['trust', 'Only the trusted endpoint or relayer can deliver messages'],
    ['invariant', 'Each message executes exactly once'],
    ['external', 'The source chain does not reorganize after we act'],
    ['trust', 'Validator or signer keys are never compromised'],
  ],
  staking: [
    ['invariant', 'Reward accounting is updated before every stake change'],
    ['economic', 'Nobody can stake and unstake in one block to farm rewards'],
    ['invariant', 'Slashing reaches pending withdrawals too'],
    ['invariant', 'The exchange rate can only go up (absent slashing)'],
  ],
  'nft-market': [
    ['invariant', 'A cancelled or filled order can never be filled again'],
    ['input', 'Signatures cover every field that matters, including the chain'],
    ['economic', 'Royalties and fees never exceed the price'],
    ['trust', 'Users only approve the marketplace for what they list'],
  ],
  governance: [
    ['economic', 'Voting power cannot be borrowed for one block'],
    ['trust', 'Every sensitive action goes through the timelock'],
    ['trust', 'Proposals cannot call arbitrary, dangerous targets'],
    ['invariant', 'Quorum cannot be reached by a single whale or flash loan'],
  ],
  oracle: [
    ['trust', 'Only authorized reporters can push prices'],
    ['external', 'Consumers check freshness and bounds themselves'],
    ['economic', 'Manipulating the source costs more than it earns'],
  ],
  token: [
    ['trust', 'Only the minter role can create supply'],
    ['input', 'Integrators handle our transfer semantics (fees, hooks, rebases)'],
    ['invariant', 'Total supply equals the sum of balances on every path'],
  ],
  vault: [
    ['invariant', 'Share price cannot be inflated by donating assets'],
    ['trust', 'The keeper/strategist is trusted and will not abuse harvest'],
    ['input', 'The asset is a standard ERC20 (no fees, hooks or rebases)'],
    ['invariant', 'State is updated before any external call or callback'],
    ['economic', 'Harvest swaps cannot be sandwiched for profit'],
  ],
  factory: [
    ['trust', 'The factory never uses the powers it keeps over what it deploys'],
    ['invariant', 'Deployer and helper roles are renounced after setup'],
    ['input', 'Deployed contracts are initialized in the same transaction'],
  ],
  'dao-module': [
    ['trust', 'The module owner is dead, so nobody can reconfigure it'],
    ['economic', 'Bonds are large enough that nobody answers falsely'],
    ['trust', 'Members watch proposals within the cooldown'],
    ['external', 'The arbitrator resolves disputes honestly and in time'],
  ],
  'nft-custody': [
    ['invariant', 'NFTs only leave custody through an approved buyout or vote'],
    ['input', 'Only standard ERC721/1155 tokens are deposited'],
    ['economic', 'Buyout prices reflect what holders agreed to'],
  ],
  naming: [
    ['trust', 'Operators over the parent name never act on their own'],
    ['invariant', 'Only intended parties can create subnames'],
    ['external', 'Users verify the resolved address before sending funds'],
  ],
  other: [
    ['trust', 'Admin and privileged roles are trusted and their keys are safe'],
    ['input', 'Inputs are validated at the boundary'],
    ['invariant', 'State is updated before external calls'],
    ['external', 'External contracts behave as documented'],
  ],
};

for (const t of ENUMS.protocolType) {
  if (!PLAYBOOKS[t]) throw new Error(`missing playbook for protocol type ${t}`);
  if (!COMMON_ASSUMPTIONS[t]) throw new Error(`missing common assumptions for ${t}`);
}

export const PHASES = {
  mapping: 'Map the system: every contract, actor and external dependency, and how they connect.',
  assumptions: 'Write down what the developers assume: trust model, invariants, input and external expectations.',
  hunting: 'Hunt: review each part against the playbook, form hypotheses, prove findings.',
  reporting: 'Write up and disclose the findings.',
};

// How far a target's map and assumptions have come.
export function phaseStatus(state, targetId) {
  const comps = Object.values(state.items.component).filter((c) => c.targetId === targetId);
  const rels = Object.values(state.items.relation || {}).filter((r) => r.targetId === targetId);
  const asms = Object.values(state.items.assumption).filter((a) => a.targetId === targetId);
  return {
    components: comps.length,
    actors: comps.filter((c) => c.type === 'actor').length,
    externals: comps.filter((c) => c.type === 'external').length,
    summarized: comps.filter((c) => c.summary).length,
    relations: rels.length,
    developerAssumptions: asms.filter((a) => a.origin === 'developer').length,
  };
}

export function playbook(type) {
  const pb = PLAYBOOKS[type] || PLAYBOOKS.other;
  return {
    type: PLAYBOOKS[type] ? type : 'other',
    ...pb,
    commonAssumptions: (COMMON_ASSUMPTIONS[type] || COMMON_ASSUMPTIONS.other).map(([category, text]) => ({ category, text })),
    classes: pb.classes.map((id) => ({ id, ...CLASSES[id], checks: CLASSES[id].checks.map((text, i) => ({ id: `${id}.${i}`, text })) })),
  };
}

// A target can stack playbooks (e.g. factory + dao-module + naming) and ignore classes that do not apply.
export function playbookFor(target) {
  const types = [...new Set([target?.protocolType || 'other', ...((target?.playbooks) || [])])].filter((t) => PLAYBOOKS[t]);
  const ignored = new Set(target?.ignoredClasses || []);
  const parts = types.map((t) => playbook(t));
  const seen = new Set();
  const classes = [];
  for (const pb of parts) for (const c of pb.classes) if (!seen.has(c.id) && !ignored.has(c.id)) { seen.add(c.id); classes.push(c); }
  const asm = [];
  const seenA = new Set();
  for (const pb of parts) for (const a of pb.commonAssumptions) if (!seenA.has(a.text)) { seenA.add(a.text); asm.push(a); }
  return {
    type: types.join('+'), types, name: parts.map((p) => p.name).join(' + '), summary: parts.map((p) => p.summary).join(' '),
    startHere: parts.map((p) => p.startHere).join(' '), classes, commonAssumptions: asm, ignored: [...ignored],
  };
}

export function allPlaybooks() {
  return Object.keys(PLAYBOOKS).map((t) => ({ type: t, name: PLAYBOOKS[t].name, summary: PLAYBOOKS[t].summary }));
}

// Checklist for a component, derived from its target's playbook.
export function checklistFor(target, component) {
  const pb = playbookFor(target);
  const done = component?.checklist || {};
  return pb.classes.map((cls) => ({
    classId: cls.id,
    name: cls.name,
    items: cls.checks.map((c) => ({ ...c, state: done[c.id]?.state || 'unchecked', by: done[c.id]?.by, at: done[c.id]?.at })),
  }));
}

// ---------- glossary (the hover layer) ----------

export const GLOSSARY = {
  'attack surface': 'Every place an attacker can interact with the system: public functions, inputs, admin paths.',
  coverage: 'How much of the attack surface has actually been looked at, and how carefully.',
  assumption: 'Something being taken for granted, like "only the owner can call this". If it is wrong, conclusions built on it are wrong too.',
  hypothesis: 'A suspected bug that has not been proven yet. It gets tested until it is confirmed or dropped.',
  finding: 'A confirmed vulnerability with enough evidence to report.',
  steer: 'A signal you leave for an agent: re-check this, cover that, challenge this assumption. It never stops the agent; it just points it.',
  evidence: 'What backs a claim: the function, line, transaction or test the agent looked at.',
  verification: 'Your own judgement of an agent\'s claim: unverified (default), verified (you checked and agree), disputed (you checked and do not buy it).',
  reentrancy: CLASSES.reentrancy.plain,
  'flash loan': 'A loan that must be borrowed and repaid in the same transaction. It lets anyone act like they have millions for a moment.',
  oracle: 'A source of outside data, usually prices, that a contract trusts.',
  twap: 'Time-weighted average price. Harder to manipulate than a spot price, but only if the window is long enough.',
  slippage: 'The difference between the price you expect and the price you get. Limits on it protect against sandwiches.',
  sandwich: 'A bot trades right before and right after your trade to profit from the price move you cause.',
  mev: 'Maximal extractable value: profit someone can take by reordering, inserting, or censoring transactions.',
  invariant: 'A rule that must always hold, like "total shares equal total deposits" or x * y = k.',
  'health factor': 'How safe a loan is. Below 1 it can be liquidated.',
  liquidation: 'Closing a risky loan by selling its collateral, usually with a bonus for whoever does it.',
  'bad debt': 'Debt that the collateral can no longer cover. Someone else ends up paying for it.',
  'share inflation': CLASSES['share-inflation'].plain,
  'access control': CLASSES['access-control'].plain,
  'checks-effects-interactions': 'A safe ordering: check inputs, update your own state, and only then call other contracts.',
  'fee-on-transfer': 'A token that takes a cut on every transfer, so the receiver gets less than was sent.',
  rebasing: 'A token whose balances change on their own (for example to pay yield).',
  'signature replay': CLASSES['signature-replay'].plain,
  'eip-712': 'A standard for signing structured data, including a domain that pins the chain and contract.',
  nonce: 'A number used once. It stops the same signed message from being used twice.',
  proxy: 'A contract that forwards calls to a separate implementation, so the code can be upgraded.',
  timelock: 'A delay between approving a change and it taking effect, so users can react.',
  quorum: 'The minimum amount of votes for a proposal to count.',
  'funding rate': 'Periodic payments between longs and shorts that keep a perp price close to the index.',
  slashing: 'Penalty taken from stakers when the validator they back misbehaves.',
  severity: 'How bad a finding is: critical (funds at direct risk) down to info (worth knowing, not exploitable).',
  'review state': 'Untouched (nobody looked), scanning (being looked at), reviewed (looked at, nothing found), flagged (something smells).',
  confidence: 'How sure the agent is that a hypothesis is a real bug: low, med or high.',
  disclosed: 'The bug was fixed and the details made public, following responsible disclosure.',
  'responsible disclosure': 'Reporting a bug privately to the team first and only going public after a fix, so users are not put at risk.',
  'bug class': 'The family a bug belongs to, like reentrancy or rounding. Useful for finding siblings.',
  dos: 'Denial of service: making something important always fail.',
  'first depositor': CLASSES['share-inflation'].plain,
};

// ---------- suggestions ----------

const PRIORITY_BONUS = { low: -10, normal: 0, high: 15, urgent: 30 };

function sid(...parts) {
  return `sg_${crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10)}`;
}

export function suggest(state, { limit = 10 } = {}) {
  const items = state.items;
  const dismissed = new Set(state.project?.dismissed || []);
  const openSteers = Object.values(items.steer).filter((s) => s.state !== 'addressed');
  const steered = (itemId, action) => openSteers.some((s) => s.itemId === itemId && (!action || s.action === action));
  const targets = items.target;
  const out = [];
  const push = (s) => { if (!dismissed.has(s.id) && !steered(s.itemId, s.action)) out.push(s); };

  // the default order: map first, then the developers' assumptions, then hunt
  for (const t of Object.values(targets)) {
    const ps = phaseStatus(state, t.id);
    if ((t.phase || 'mapping') === 'mapping') {
      push({
        id: sid('map', t.id), rule: 'phase-mapping', action: 'cover', itemId: t.id, itemKind: 'target',
        score: 90 + PRIORITY_BONUS[t.priority || 'normal'],
        title: `Map how ${t.name} fits together`,
        why: `Before hunting: list every contract, actor and external dependency and how they call, transfer to and trust each other. So far: ${ps.components} parts, ${ps.relations} connections.`,
      });
    } else if (t.phase === 'assumptions' || ps.developerAssumptions < 3) {
      push({
        id: sid('dev-assumptions', t.id), rule: 'phase-assumptions', action: 'cover', itemId: t.id, itemKind: 'target',
        score: (t.phase === 'assumptions' ? 85 : 55) + PRIORITY_BONUS[t.priority || 'normal'],
        title: `Write down what ${t.name}'s developers assume`,
        why: `Trust model, invariants, what inputs and tokens they expect. Bugs live where these turn out false. ${ps.developerAssumptions} recorded so far.`,
      });
    }
  }

  // disputed claims nobody is revisiting
  for (const kind of ['component', 'assumption', 'hypothesis', 'finding']) {
    for (const it of Object.values(items[kind])) {
      if (it.verification !== 'disputed') continue;
      push({
        id: sid('disputed', it.id), rule: 'disputed', action: kind === 'assumption' ? 'challenge' : 'recheck',
        itemId: it.id, itemKind: kind, score: 70 + PRIORITY_BONUS[it.priority || 'normal'],
        title: `Revisit disputed ${kind}: ${short(it.name || it.text || it.title)}`,
        why: 'You disputed this and nobody is revisiting it yet.',
      });
    }
  }

  // untouched surface
  for (const c of Object.values(items.component)) {
    if (c.reviewState !== 'untouched' || !isReviewable(c)) continue;
    const t = targets[c.targetId];
    if ((t?.phase || 'mapping') === 'mapping') continue;
    push({
      id: sid('cover', c.id), rule: 'untouched', action: 'cover', itemId: c.id, itemKind: 'component',
      score: 50 + PRIORITY_BONUS[c.priority || 'normal'] + PRIORITY_BONUS[t?.priority || 'normal'],
      title: `Cover ${c.name}`,
      why: `Nobody has looked at this part of ${t?.name || 'the target'} yet. Dark areas are where bugs hide.`,
    });
  }

  // flagged with nothing to show for it
  const workedOn = new Set([
    ...Object.values(items.hypothesis).filter((h) => h.status !== 'dropped').map((h) => h.componentId),
    ...Object.values(items.finding).map((f) => f.componentId),
  ].filter(Boolean));
  for (const c of Object.values(items.component)) {
    if (c.reviewState !== 'flagged' || workedOn.has(c.id)) continue;
    push({
      id: sid('flag-to-hyp', c.id), rule: 'flagged-no-hypothesis', action: 'note', itemId: c.id, itemKind: 'component',
      score: 72 + PRIORITY_BONUS[c.priority || 'normal'],
      title: `Turn the flag on ${c.name} into a hypothesis`,
      why: 'Something smelled here, but nobody wrote down what. A hypothesis makes it testable.',
    });
  }

  // unverified assumptions
  for (const a of Object.values(items.assumption)) {
    if (a.state !== 'assumed' || a.verification !== 'unverified') continue;
    push({
      id: sid('challenge', a.id), rule: 'unverified-assumption', action: 'challenge', itemId: a.id, itemKind: 'assumption',
      score: (a.origin === 'developer' ? 58 : 46) + PRIORITY_BONUS[a.priority || 'normal'],
      title: `Challenge: ${short(a.text)}`,
      why: 'This is still being taken for granted. If it is wrong, everything resting on it is too.',
    });
  }

  // confident hypotheses without evidence
  for (const h of Object.values(items.hypothesis)) {
    if (h.status !== 'testing') continue;
    if (h.confidence === 'high' || (h.confidence === 'med' && !h.evidence.length)) {
      push({
        id: sid('verify-hyp', h.id), rule: 'confident-hypothesis', action: 'verify', itemId: h.id, itemKind: 'hypothesis',
        score: (h.confidence === 'high' ? 46 : 36) + PRIORITY_BONUS[h.priority || 'normal'] - (h.evidence.length ? 6 : 0),
        title: `Prove or drop: ${short(h.text)}`,
        why: h.evidence.length ? `Rated ${h.confidence} confidence. A proof of concept would settle it.` : `Rated ${h.confidence} confidence with no evidence attached yet.`,
      });
    }
  }

  // capabilities waiting on a trigger, and findings with unfinished cards
  for (const h of Object.values(items.hypothesis)) {
    if (h.exploitStage !== 'capability' || h.status === 'dropped') continue;
    push({
      id: sid('trigger', h.id), rule: 'capability-no-trigger', action: 'cover', itemId: h.id, itemKind: 'hypothesis',
      score: 64 + PRIORITY_BONUS[h.priority || 'normal'],
      title: `Hunt the trigger: ${short(h.text)}`,
      why: 'The power exists but nothing shows a public path that makes it fire. Find the trigger, or record why there is none.',
    });
  }
  for (const f of Object.values(items.finding)) {
    const missing = ['attacker', 'reachability', 'bound', 'liveFunds', 'alreadyReported', 'verificationMethod'].filter((k) => !f[k]);
    if (!missing.length) continue;
    push({
      id: sid('card', f.id), rule: 'finding-card', action: 'verify', itemId: f.id, itemKind: 'finding',
      score: 66 + (f.severity === 'critical' ? 10 : f.severity === 'high' ? 5 : 0),
      title: `Finish the confirmation card for "${short(f.title)}"`,
      why: `Missing: ${missing.join(', ')}. Without them the severity is a guess and the report is easy to reject.`,
    });
  }
  for (const l of Object.values(items.lead || {})) {
    if (l.state !== 'open' || l.value !== 'high') continue;
    push({
      id: sid('lead', l.id), rule: 'open-lead', action: 'cover', itemId: l.id, itemKind: 'lead',
      score: 52, title: `Open thread: ${short(l.text)}`, why: l.why || 'Marked high value and not done yet.',
    });
  }

  // findings without repro
  for (const f of Object.values(items.finding)) {
    if (!['recon', 'testing'].includes(f.stage) || f.repro) continue;
    push({
      id: sid('repro', f.id), rule: 'finding-no-repro', action: 'verify', itemId: f.id, itemKind: 'finding',
      score: 44 + (f.severity === 'critical' ? 15 : f.severity === 'high' ? 8 : 0),
      title: `Get a reproduction for "${short(f.title)}"`,
      why: 'A finding without a repro is hard to report and easy to dismiss.',
    });
  }

  // playbook classes nobody has checked on a target
  for (const t of Object.values(targets)) {
    const comps = Object.values(items.component).filter((c) => c.targetId === t.id && isReviewable(c));
    if (!comps.length || (t.phase || 'mapping') === 'mapping') continue;
    const pb = playbookFor(t);
    const hyps = Object.values(items.hypothesis).filter((h) => h.targetId === t.id);
    // na anywhere on the target counts, including on an external part (someone else's engine)
    const all = Object.values(items.component).filter((c) => c.targetId === t.id);
    for (const cls of pb.classes.slice(0, 5)) {
      const touched = all.some((c) => Object.entries(c.checklist || {}).some(([k, v]) => (k === cls.id || k.startsWith(`${cls.id}.`)) && v.state !== 'unchecked'))
        || hyps.some((h) => (h.bugClass || '').toLowerCase().includes(cls.id.split('-')[0]));
      if (touched) continue;
      push({
        id: sid('class', t.id, cls.id), rule: 'playbook-gap', action: 'cover', itemId: t.id, itemKind: 'target',
        score: 24 + PRIORITY_BONUS[t.priority || 'normal'] - pb.classes.indexOf(cls) * 2,
        title: `Look for ${cls.name.toLowerCase()} in ${t.name}`,
        why: `A usual suspect for ${pb.name.toLowerCase()} protocols that nobody has checked yet. ${cls.plain}`,
        classId: cls.id,
      });
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function short(s, n = 70) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---------- agent briefing ----------

// What an agent needs to act now: steers, disputed claims, the next action, and
// ids. Everything else is one call away: the playbook on recon_playbook, notes and
// scope on recon_get, lists on recon_list. The rules live in the tool description.
export function briefing(state, agentId) {
  const items = state.items;
  const me = items.agent[agentId] || null;
  const mine = (s) => (s.to || []).includes('all') || (s.to || []).includes(agentId);
  const steers = Object.values(items.steer).filter((s) => s.state !== 'addressed' && mine(s))
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.createdAt - b.createdAt)
    .map((s) => ({ id: s.id, action: s.action, state: s.state, note: s.note, item: describeRef(items, s.itemId) }));
  const assignment = new Set(me?.assignment || []);
  const owned = Object.values(items.component).filter((c) => c.owner === agentId || assignment.has(c.id) || assignment.has(c.targetId));
  const untouched = Object.values(items.component).filter((c) => isReviewable(c) && c.reviewState === 'untouched' && (!c.owner || c.owner === agentId))
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));
  const disputed = [];
  for (const kind of ['component', 'assumption', 'hypothesis', 'finding']) {
    for (const it of Object.values(items[kind])) {
      if (it.verification === 'disputed' && (it.createdBy === agentId || !it.createdBy?.startsWith('ag_'))) disputed.push({ id: it.id, kind, label: short(it.name || it.text || it.title, 80) });
    }
  }
  const decided = Object.values(items.proposal).filter((p) => p.createdBy === agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
    .map((p) => ({ id: p.id, state: p.state, choice: p.choice || undefined }));
  const targets = Object.values(items.target).map((t) => {
    const comps = Object.values(items.component).filter((c) => c.targetId === t.id);
    const linked = new Set(Object.values(items.relation || {}).filter((r) => r.targetId === t.id).flatMap((r) => [r.from, r.to]));
    const loose = comps.filter((c) => !linked.has(c.id));
    return {
      id: t.id, name: t.name, protocolType: t.protocolType, playbooks: playbookFor(t).types,
      phase: t.phase || 'mapping', progress: phaseStatus(state, t.id),
      unconnected: loose.length ? loose.slice(0, 8).map((c) => c.id) : undefined,
    };
  });
  const mappingT = targets.find((t) => t.phase === 'mapping');
  const assumingT = targets.find((t) => t.phase === 'assumptions');
  const suggestions = suggest(state, { limit: 5 });
  let next;
  if (state.project.example) next = 'This board only holds the built-in example. Start the real engagement first (recon_start_engagement), then add the target you are researching.';
  else if (steers.some((s) => s.state === 'open')) next = 'Acknowledge your open steers first (recon_steer state=acknowledged), then work them.';
  else if (steers.length) next = 'Work your acknowledged steers and mark them addressed with a short response.';
  else if (disputed.length) next = 'A human disputed one of your claims. Revisit the evidence and either strengthen it or retract.';
  else if (!targets.length) next = 'Add the target you are researching (recon_add_target), with its protocol type.';
  else if (mappingT) {
    const p = mappingT.progress;
    next = `Phase 1, map "${mappingT.name}" (${p.components} parts, ${p.relations} connections${mappingT.unconnected ? `, ${mappingT.unconnected.length}${mappingT.unconnected.length === 8 ? '+' : ''} unconnected` : ''}): recon_scan the source, then recon_map what the scan cannot see. Every part must connect to something. Then recon_phase "assumptions".`;
  } else if (assumingT) next = `Phase 2, record what "${assumingT.name}"'s developers assume (recon_add_assumption origin="developer"); recon_playbook lists the usual ones for ${assumingT.playbooks.join(' + ')}. Then recon_phase "hunting".`;
  else if (owned.some((c) => c.reviewState !== 'reviewed')) next = 'Continue on the components you own or were assigned.';
  else if (suggestions.length) next = `${suggestions[0].title} (suggestion ${suggestions[0].id}). If it does not apply, recon_dismiss it with the reason.`;
  else next = 'Everything is covered. Propose deeper checks or new hypotheses (recon_propose).';

  return {
    you: me ? { id: me.id, name: me.name } : { id: agentId },
    project: state.project.name,
    example: Boolean(state.project.example) || undefined,
    next,
    steers,
    disputed,
    yourComponents: owned.map((c) => ({ id: c.id, reviewState: c.reviewState })),
    untouched: untouched.slice(0, 15).map((c) => c.id),
    claimedByOthers: Object.values(items.component).filter((c) => c.owner && c.owner !== agentId).map((c) => c.id),
    yourProposals: decided,
    suggestions: suggestions.map(({ id, title, action, itemId }) => ({ id, title, action, itemId })),
    targets,
  };
}

function priorityRank(p) {
  return { low: 0, normal: 1, high: 2, urgent: 3 }[p || 'normal'];
}

function describeRef(items, id) {
  if (!id) return null;
  for (const [kind, map] of Object.entries(items)) {
    const it = map[id];
    if (it) return { id, kind, label: it.name || it.text || it.title || it.note };
  }
  return null;
}
