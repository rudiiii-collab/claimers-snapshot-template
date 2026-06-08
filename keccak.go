package main

// Self-contained Keccak-256 (the Ethereum hash variant, NOT NIST SHA3-256).
// Used to derive function selectors and event topic0 signatures so we never
// have to hard-code a guessed topic hash. The only difference from SHA3-256 is
// the domain-separation/padding byte: Keccak uses 0x01, SHA3 uses 0x06.

var keccakRC = [24]uint64{
	0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
	0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
	0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
	0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
	0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
	0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
}

var keccakRot = [24]uint{
	1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
	27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
}

var keccakPiln = [24]uint{
	10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
	15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
}

func rotl64(x uint64, n uint) uint64 { return (x << n) | (x >> (64 - n)) }

func keccakF(st *[25]uint64) {
	var bc [5]uint64
	for round := 0; round < 24; round++ {
		// Theta
		for i := 0; i < 5; i++ {
			bc[i] = st[i] ^ st[i+5] ^ st[i+10] ^ st[i+15] ^ st[i+20]
		}
		for i := 0; i < 5; i++ {
			t := bc[(i+4)%5] ^ rotl64(bc[(i+1)%5], 1)
			for j := 0; j < 25; j += 5 {
				st[j+i] ^= t
			}
		}
		// Rho + Pi
		t := st[1]
		for i := 0; i < 24; i++ {
			j := keccakPiln[i]
			bc[0] = st[j]
			st[j] = rotl64(t, keccakRot[i])
			t = bc[0]
		}
		// Chi
		for j := 0; j < 25; j += 5 {
			for i := 0; i < 5; i++ {
				bc[i] = st[j+i]
			}
			for i := 0; i < 5; i++ {
				st[j+i] ^= (^bc[(i+1)%5]) & bc[(i+2)%5]
			}
		}
		// Iota
		st[0] ^= keccakRC[round]
	}
}

// Keccak256 returns the 32-byte Keccak-256 digest of data.
func Keccak256(data []byte) [32]byte {
	const rate = 136 // bytes (1088 bits) for Keccak-256
	var st [25]uint64

	// Absorb full blocks.
	in := data
	for len(in) >= rate {
		absorbBlock(&st, in[:rate])
		keccakF(&st)
		in = in[rate:]
	}

	// Pad the final (partial) block: pad10*1 with Keccak's 0x01 domain byte.
	var block [rate]byte
	copy(block[:], in)
	block[len(in)] ^= 0x01
	block[rate-1] ^= 0x80
	absorbBlock(&st, block[:])
	keccakF(&st)

	var out [32]byte
	for i := 0; i < 4; i++ {
		v := st[i]
		for b := 0; b < 8; b++ {
			out[i*8+b] = byte(v >> (8 * uint(b)))
		}
	}
	return out
}

func absorbBlock(st *[25]uint64, block []byte) {
	for i := 0; i < len(block)/8; i++ {
		var v uint64
		for b := 0; b < 8; b++ {
			v |= uint64(block[i*8+b]) << (8 * uint(b))
		}
		st[i] ^= v
	}
}
