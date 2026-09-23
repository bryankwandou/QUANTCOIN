# QuantCoin Iteration 1: Technical Specification & Protocol Baseline

## Summary of This Iteration

### 1.1 Iteration Context
This is **Iteration 1**. It establishes the core technical baseline, cryptographic primitives, and economic rules for the QuantCoin protocol. It transitions the project from a visionary concept to a rigorously specified Layer 1 architecture.

### 1.2 Key Changes and Improvements
- **Standardized Cryptography**: Locked NIST Level 5 primitives—ML-DSA-87 (Dilithium-5) for signatures and ML-KEM-1024 (Kyber-1024) for key encapsulation.
- **Consensus Formalization**: Defined the "Hyper-Sharded DAG-BFT" topology utilizing $2^{20}$ parallel shards.
- **Economic Invariants**: Solidified the 22 Trillion token supply cap and the 0.5% Anti-Whale Stagnation Tax.
- **TPS Scaling Proof**: Detailed the logarithmic routing and concurrent validation logic.
- **Founder Safeguards**: Specified the 7-of-11 Threshold Multi-Sig for the Founder Treasury.

### 1.3 Items Not Changed This Iteration
- N/A (Initial technical lock).

## 2. Updated Technical Specifications

### 2.1 Cryptography Stack
- **Signature Scheme**: **ML-DSA-87 (Dilithium-5)**. chosen for its high security margin against Shor's algorithm.
  - Public Key: 2592 bytes.
  - Secret Key: 4896 bytes.
  - Signature Size: 4595 bytes.
- **Key Encapsulation (KEM)**: **ML-KEM-1024 (Kyber-1024)** for all P2P node-to-node handshakes.
  - Public Key: 1568 bytes.
  - Ciphertext: 1568 bytes.
- **Address Format**: `QCv1` prefix. Uses a variation of Base58 encoding a version byte, a 32-byte PQC public key hash (SHA3-256), and a 4-byte CRC32 integrity check. Forward-compatible via the version byte.
- **Seed Phrases**: 24-word BIP39 compliant, but mapped to a 512-bit entropy pool processed through Argon2id for PQC-safe key derivation.

### 2.2 Network & Communication Layer
- **P2P Protocol**: Custom implementation over `libp2p` with Noise-PQ handshake.
- **Discovery**: Kademlia DHT modified for shard-specific peer routing.
- **Resilience**: 
  - **LoRaWAN Side-Channel**: Nodes can broadcast signed transaction hashes via sub-GHz radio (868/915 MHz) for local mesh synchronization when the backbone is severed.
  - **Satellite Sync**: Integrated support for LEO satellite block header broadcasting to ensure global consensus consistency.

### 2.3 Consensus & Ledger Structure
- **Topology**: Vertices in a Directed Acyclic Graph (DAG) for unprivileged transaction intake.
- **BFT Finalization**: **HotStuff-variant** synchronous consensus gadget that periodically "checkpoints" the DAG to provide absolute finality.
- **State Model**: Account-based state transition system (ATS) with shard-local state trees.

### 2.4 Performance & Scalability (1 Trillion TPS Proof)
The **1,000,000,000,000 TPS** target is achieved via:
- **Shard Capacity**: Each of the $1,048,576$ shards targets ~1,000,000 TPS.
- **Logarithmic Intra-Shard Routing**: Transactions are routed to shards based on the XOR distance of the sender/receiver address.
- **Parallel Validation**: Each shard operates its own DAG-BFT instance. Cross-shard transactions are resolved via **Non-Blocking Promise Receipts (NBPR)**.
- **Aggregation**: Shard state roots are aggregated via a recursive SNARK (Halo2) tree, allowing the entire global state update to be verified in $O(\log(\text{shards}))$ time.

### 2.5 Tokenomics
- **Total Supply**: 22,000,000,000,000 QC.
- **Inflation**: 1% initial annual inflation, decaying at 5% per annum until a tail emission of 0.1% is reached (Year 15).
- **Founder Allocation**: 5% (1.1T QC) locked in a Genesis Smart Contract. Vested linearly over 120 months.
- **Anti-Whale Cap**: Any entity cluster (identified by heuristic graph analysis) controlling >0.5% total supply is subject to a **0.5% Annual Stagnation Fee** on the excess balance. Fees are burned.
- **Mining**:
  - **Classical**: Mem-hard Proof-of-Work (Argon2id) to ensure fair distribution.
  - **Quantum (PoQ)**: Specialized challenges requiring quantum state fidelity verification. Efficiency is high but capped at **0.5 QC / 24h** per verified unique quantum signature (preventing qubit-farming domination).
- **Fees**: 0.0000001 QC base. Collected and sent to the **Founder Treasury**.

### 2.6 Governance & Anti-Manipulation
- **Mechanism**: **Quadratic Representative DAO**. Voting power = $\sqrt{\text{Stake}}$.
- **Veto**: 2/3 majority of "Active Citizen" nodes (low-stake but high-uptime nodes) can veto institutional proposals even if out-voted by whales.

### 2.7 Founder Treasury Wallet Security
- **Architecture**: 7-of-11 Threshold Multi-Signature. 
- **Keys**: Distributed across offline hardware signing modules (HSMs), geographic isolation (3 continents), and social recovery shards.
- **Rule**: Outbound transfers must be queued for 7 days on-chain for community audit before execution.

## 3. Updated Whitepaper Sections

### 3.1 Abstract
QuantCoin is a post-quantum Layer 1 protocol designed to neutralize the existential threat posed by Shor's algorithm to traditional elliptic curve cryptography. By merging lattice-based ML-DSA primitives with a hyper-sharded DAG-BFT consensus engine, QuantCoin achieves a theoretical throughput of 1 Trillion TPS while enforcing strict economic sovereignty for both human and machine agents.

### 3.4 System Overview
The system architecture segments the global state into $2^{20}$ autonomous shards... [Full details in Iteration 1 Technical Specification]

### 3.7 Tokenomics and Economic Model
The 22 Trillion Law ensures scarcity in a post-abundance quantum world... [Locked for Iteration 1]

## 4. Risks and Limitations
- **4.1 Technical**: High shard counts increase the complexity of cross-shard networking and proof aggregation.
- **4.2 Economic**: Anti-whale heuristics may be partially bypassed via sophisticated shell-account layering; requires constant protocol-level refinement.
- **4.3 Cryptographic**: While ML-DSA-87 is NIST standard, lattice-based cryptography is relatively young compared to RSA/ECDSA; continuous monitoring of cryptanalysis is mandatory.

## 5. Next Iteration Goals
- **5.1**: Formalize the ZK-SNARK circuit for cross-shard promise aggregation.
- **5.2**: Detail the "Gravity" bridge protocol for collateralized classical assets.
- **5.3**: Resolve the peer-sampling latency trade-offs in $10^6$ shard environments.
