package main

import (
	"fmt"
	"math/big"
	"strings"
)

// Selectors for the CL (Slipstream) path.
var (
	selSlot0         = selector("slot0()")
	selTickSpacing   = selector("tickSpacing()")
	selTokenOfOwner  = selector("tokenOfOwnerByIndex(address,uint256)")
	selPositions     = selector("positions(uint256)")
	selGauges        = selector("gauges(address)")
	selStakedValues  = selector("stakedValues(address)")
	selNFT           = selector("nft()")
)

// CLPool holds the per-block state of a concentrated-liquidity pool.
type CLPool struct {
	Address      string
	Token0       string
	Token1       string
	AoraIsToken0 bool
	TickSpacing  int
	SqrtPriceX96 *big.Int
	Gauge        string // CL gauge that holds staked positions (may be empty)
	NFPM         string // NonfungiblePositionManager
}

// position is one decoded NFPM position.
type position struct {
	tokenID   *big.Int
	token0    string
	token1    string
	tickLower int
	tickUpper int
	liquidity *big.Int
}

// loadCLPool reads slot0/tickSpacing/tokens and resolves gauge + NFPM.
func loadCLPool(c *Client, cfg *Config, poolAddr string, block uint64) (*CLPool, error) {
	t0, err := c.EthCall(poolAddr, selToken0, block)
	if err != nil {
		return nil, fmt.Errorf("token0: %w", err)
	}
	t1, err := c.EthCall(poolAddr, selToken1, block)
	if err != nil {
		return nil, fmt.Errorf("token1: %w", err)
	}
	slot0, err := c.EthCall(poolAddr, selSlot0, block)
	if err != nil {
		return nil, fmt.Errorf("slot0: %w", err)
	}
	ts, err := c.EthCall(poolAddr, selTickSpacing, block)
	if err != nil {
		return nil, fmt.Errorf("tickSpacing: %w", err)
	}
	p := &CLPool{
		Address:      strings.ToLower(poolAddr),
		Token0:       returnAddress(t0),
		Token1:       returnAddress(t1),
		TickSpacing:  int(returnUint(ts).Int64()),
		SqrtPriceX96: returnUint(slot0), // first word of slot0
	}
	p.AoraIsToken0 = p.Token0 == cfg.AoraToken

	// Resolve the CL gauge via Voter.gauges(pool), then NFPM via gauge.nft().
	if cfg.Voter != "" {
		gret, err := c.EthCall(cfg.Voter, selGauges+encAddress(poolAddr), block)
		if err == nil {
			p.Gauge = returnAddress(gret)
		}
	}
	if p.Gauge != "" && p.Gauge != "0x0000000000000000000000000000000000000000" {
		nret, err := c.EthCall(p.Gauge, selNFT, block)
		if err == nil {
			p.NFPM = returnAddress(nret)
		}
	}
	return p, nil
}

// walletTokenIds returns all NFPM tokenIds a wallet controls: unstaked (held as
// NFTs) plus staked in the CL gauge.
func walletTokenIds(c *Client, pool *CLPool, wallet string, block uint64) ([]*big.Int, error) {
	var ids []*big.Int

	// Unstaked NFTs held directly.
	if pool.NFPM != "" {
		balRet, err := c.EthCall(pool.NFPM, selBalanceOf+encAddress(wallet), block)
		if err != nil {
			return nil, err
		}
		n := int(returnUint(balRet).Int64())
		for i := 0; i < n; i++ {
			idxArg := fmt.Sprintf("%064x", i)
			ret, err := c.EthCall(pool.NFPM, selTokenOfOwner+encAddress(wallet)+idxArg, block)
			if err != nil {
				return nil, err
			}
			ids = append(ids, returnUint(ret))
		}
	}

	// Staked positions in the gauge.
	if pool.Gauge != "" && pool.Gauge != "0x0000000000000000000000000000000000000000" {
		ret, err := c.EthCall(pool.Gauge, selStakedValues+encAddress(wallet), block)
		if err == nil {
			ids = append(ids, decodeUintArray(ret)...)
		}
	}
	return ids, nil
}

// decodeUintArray decodes an ABI-encoded uint256[] return.
func decodeUintArray(ret string) []*big.Int {
	w := dataWords(ret)
	if len(w) < 2 {
		return nil
	}
	// w[0] = offset (0x20), w[1] = length, then elements.
	n := int(hexToBig("0x" + w[1]).Int64())
	var out []*big.Int
	for i := 0; i < n && 2+i < len(w); i++ {
		out = append(out, hexToBig("0x"+w[2+i]))
	}
	return out
}

// loadPosition decodes NFPM.positions(tokenId).
func loadPosition(c *Client, pool *CLPool, tokenID *big.Int, block uint64) (*position, error) {
	arg := fmt.Sprintf("%064x", tokenID)
	ret, err := c.EthCall(pool.NFPM, selPositions+arg, block)
	if err != nil {
		return nil, err
	}
	w := dataWords(ret)
	if len(w) < 8 {
		return nil, fmt.Errorf("positions(%s): short return", tokenID)
	}
	// Slipstream layout: nonce, operator, token0, token1, tickSpacing,
	// tickLower, tickUpper, liquidity, ...
	return &position{
		tokenID:   tokenID,
		token0:    "0x" + strings.ToLower(w[2][24:]),
		token1:    "0x" + strings.ToLower(w[3][24:]),
		tickLower: signedTick(w[5]),
		tickUpper: signedTick(w[6]),
		liquidity: hexToBig("0x" + w[7]),
	}, nil
}

// aoraAmount returns the AORA-side token amount of a position at the pool price.
func (p *CLPool) aoraAmount(pos *position) *big.Int {
	if pos.token0 != p.Token0 || pos.token1 != p.Token1 {
		return new(big.Int) // not this pool
	}
	a0, a1 := PositionAmounts(p.SqrtPriceX96, pos.tickLower, pos.tickUpper, pos.liquidity)
	if p.AoraIsToken0 {
		return a0
	}
	return a1
}

// SnapshotCLLP computes each claimer's AORA held inside the given concentrated-
// liquidity pools at `block`, returning wallet -> AORA raw (base units). It uses
// staged Multicall3 batches so there is never one-RPC-call-per-wallet:
//
//	Pass A: NFPM.balanceOf + gauge.stakedValues for every (wallet, pool)
//	Pass B: tokenOfOwnerByIndex for the few wallets holding unstaked NFTs
//	Pass C: positions(tokenId) for every discovered tokenId
func SnapshotCLLP(c *Client, cfg *Config, claimers []Claimer, pools []*CLPool, block uint64) (map[string]*big.Int, error) {
	out := map[string]*big.Int{}
	if len(pools) == 0 {
		return out, nil
	}
	batch := cfg.MulticallBatch

	// ---- Pass A: balanceOf (unstaked count) + stakedValues (staked ids) ----
	type aKey struct {
		wallet string
		pool   int
	}
	var aCalls []Call3
	var aMeta []aKey
	for _, cl := range claimers {
		for pi, p := range pools {
			// The Dune dataset counts only gauge-staked CL liquidity. Unstaked
			// NFT positions are included only when LPStakedOnly is disabled.
			if !cfg.LPStakedOnly && p.NFPM != "" {
				aCalls = append(aCalls, Call3{Target: p.NFPM, Data: selBalanceOf + encAddress(cl.Wallet)})
				aMeta = append(aMeta, aKey{cl.Wallet, pi})
			}
			if hasAddr(p.Gauge) {
				aCalls = append(aCalls, Call3{Target: p.Gauge, Data: selStakedValues + encAddress(cl.Wallet)})
				aMeta = append(aMeta, aKey{cl.Wallet, pi})
			}
		}
	}
	aRes, err := c.MultiCall(aCalls, block, batch)
	if err != nil {
		return nil, err
	}

	// tokenIds discovered per (wallet,pool); unstaked counts to expand in pass B.
	staked := map[aKey][]*big.Int{}
	unstakedCount := map[aKey]int{}
	for i, m := range aMeta {
		r := aRes[i]
		if !r.Success {
			continue
		}
		isStakedCall := strings.HasPrefix(aCalls[i].Data, selStakedValues)
		if isStakedCall {
			staked[m] = append(staked[m], decodeUintArray(r.Ret)...)
		} else {
			unstakedCount[m] = int(returnUint(r.Ret).Int64())
		}
	}

	// ---- Pass B: tokenOfOwnerByIndex for wallets with unstaked NFTs ----
	var bCalls []Call3
	var bMeta []aKey
	for m, n := range unstakedCount {
		for i := 0; i < n; i++ {
			bCalls = append(bCalls, Call3{
				Target: pools[m.pool].NFPM,
				Data:   selTokenOfOwner + encAddress(m.wallet) + fmt.Sprintf("%064x", i),
			})
			bMeta = append(bMeta, m)
		}
	}
	unstaked := map[aKey][]*big.Int{}
	if len(bCalls) > 0 {
		bRes, err := c.MultiCall(bCalls, block, batch)
		if err != nil {
			return nil, err
		}
		for i, m := range bMeta {
			if bRes[i].Success {
				unstaked[m] = append(unstaked[m], returnUint(bRes[i].Ret))
			}
		}
	}

	// ---- Pass C: positions(tokenId) for all unique tokenIds (per pool) ----
	type cKey struct {
		pool int
		id   string
	}
	posCallIdx := map[cKey]int{}
	var cCalls []Call3
	var cKeys []cKey
	addPos := func(pi int, id *big.Int) {
		k := cKey{pi, id.String()}
		if _, ok := posCallIdx[k]; ok {
			return
		}
		posCallIdx[k] = len(cCalls)
		cCalls = append(cCalls, Call3{Target: pools[pi].NFPM, Data: selPositions + fmt.Sprintf("%064x", id)})
		cKeys = append(cKeys, k)
	}
	for m, ids := range staked {
		for _, id := range ids {
			addPos(m.pool, id)
		}
	}
	for m, ids := range unstaked {
		for _, id := range ids {
			addPos(m.pool, id)
		}
	}
	posByKey := map[cKey]*position{}
	if len(cCalls) > 0 {
		cRes, err := c.MultiCall(cCalls, block, batch)
		if err != nil {
			return nil, err
		}
		for i, k := range cKeys {
			if !cRes[i].Success {
				continue
			}
			w := dataWords(cRes[i].Ret)
			if len(w) < 8 {
				continue
			}
			posByKey[k] = &position{
				token0:    "0x" + strings.ToLower(w[2][24:]),
				token1:    "0x" + strings.ToLower(w[3][24:]),
				tickLower: signedTick(w[5]),
				tickUpper: signedTick(w[6]),
				liquidity: hexToBig("0x" + w[7]),
			}
		}
	}

	// ---- Sum AORA per wallet ----
	add := func(wallet string, amt *big.Int) {
		if amt.Sign() == 0 {
			return
		}
		if out[wallet] == nil {
			out[wallet] = new(big.Int)
		}
		out[wallet].Add(out[wallet], amt)
	}
	for m, ids := range staked {
		for _, id := range ids {
			if pos := posByKey[cKey{m.pool, id.String()}]; pos != nil {
				add(m.wallet, pools[m.pool].aoraAmount(pos))
			}
		}
	}
	for m, ids := range unstaked {
		for _, id := range ids {
			if pos := posByKey[cKey{m.pool, id.String()}]; pos != nil {
				add(m.wallet, pools[m.pool].aoraAmount(pos))
			}
		}
	}
	return out, nil
}

func hasAddr(a string) bool {
	return a != "" && a != "0x0000000000000000000000000000000000000000"
}

// DebugLP dumps amount0/amount1 per LP wallet against the reference, to pin the
// exact AORA_LP formula the dataset used.
func DebugLP(c *Client, cfg *Config, block uint64, refPath string) error {
	if len(cfg.Pools) == 0 {
		return fmt.Errorf("set POOLS to the CL pool address")
	}
	pool, err := loadCLPool(c, cfg, cfg.Pools[0], block)
	if err != nil {
		return err
	}
	fmt.Printf("pool=%s token0=%s token1=%s aoraIsToken0=%t tickSpacing=%d sqrtP=%s\n",
		pool.Address, pool.Token0, pool.Token1, pool.AoraIsToken0, pool.TickSpacing, pool.SqrtPriceX96)
	fmt.Printf("gauge=%s nfpm=%s\n", pool.Gauge, pool.NFPM)

	// reference LP per wallet
	refLP := map[string]string{}
	if refPath != "" {
		_, rows, _ := readCSV(refPath)
		for _, r := range rows {
			if len(r) >= 4 {
				refLP[strings.ToLower(r[0])] = r[3]
			}
		}
	}

	e18 := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	e6 := new(big.Int).Exp(big.NewInt(10), big.NewInt(6), nil)
	ff := func(x *big.Int, d *big.Int) float64 { f, _ := new(big.Rat).SetFrac(x, d).Float64(); return f }

	for w, ref := range refLP {
		if ref == "0.0" || ref == "" {
			continue
		}
		ids, err := walletTokenIds(c, pool, w, block)
		if err != nil {
			return err
		}
		sum0, sum1 := new(big.Int), new(big.Int)
		for _, id := range ids {
			pos, err := loadPosition(c, pool, id, block)
			if err != nil {
				continue
			}
			if pos.token0 != pool.Token0 || pos.token1 != pool.Token1 {
				continue
			}
			a0, a1 := PositionAmounts(pool.SqrtPriceX96, pos.tickLower, pos.tickUpper, pos.liquidity)
			sum0.Add(sum0, a0)
			sum1.Add(sum1, a1)
		}
		fmt.Printf("wallet=%s positions=%d amount0(AORA)=%.6f amount1(USDC)=%.6f  REF=%s\n",
			w, len(ids), ff(sum0, e18), ff(sum1, e6), ref)
	}
	return nil
}
