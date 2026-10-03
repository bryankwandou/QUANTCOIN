// Hybrid vault keys and the spend flow. Mirror of client/qc.ts + client/spend.ts:
// a fee key pays fees and receives the closed account's rent; the vault owner
// key only signs (the program rejects the same account in two slots).
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:convert/convert.dart' show hex;
import 'package:cryptography/cryptography.dart';

import 'pda.dart';
import 'tx.dart';
import 'wots.dart';

const qcProgram = 'CiupyGrAtWomKW5rDWbaMEsm3Db8pY8NPECgL2FfACms';

Uint8List randomBytes(int n) {
  final r = Random.secure();
  return Uint8List.fromList(List.generate(n, (_) => r.nextInt(256)));
}

/// An Ed25519 key from its 32-byte seed.
class EdKey {
  final Uint8List seed;
  EdKey(this.seed);
  factory EdKey.fresh() => EdKey(randomBytes(32));

  String? _addr;
  Future<SimpleKeyPair> get _kp => Ed25519().newKeyPairFromSeed(seed);
  Future<String> address() async => _addr ??= b58encode((await (await _kp).extractPublicKey()).bytes);
  Future<List<int>> sign(List<int> msg) async => (await Ed25519().sign(msg, keyPair: await _kp)).bytes;
}

class VaultKeys {
  final EdKey owner;
  final Uint8List master, seed;
  /// Hex of the one digest this WOTS key signed. Saved BEFORE broadcasting.
  String? signed;

  VaultKeys(this.owner, this.master, this.seed, {this.signed});

  factory VaultKeys.fresh(EdKey owner) => VaultKeys(owner, randomBytes(32), randomBytes(seedLen));

  /// Accepts the JSON the CLI writes to client/keys/vault-*.json.
  factory VaultKeys.fromCli(String json) {
    final j = jsonDecode(json) as Map<String, dynamic>;
    final owner = (j['owner'] as List).cast<int>();
    if (owner.length != 64) throw const FormatException('owner must be a 64-byte secret key');
    return VaultKeys(EdKey(Uint8List.fromList(owner.sublist(0, 32))),
        Uint8List.fromList(hex.decode(j['master'] as String)),
        Uint8List.fromList(hex.decode(j['seed'] as String)),
        signed: j['signed'] as String?);
  }

  Map<String, dynamic> toJson() => {
        'ownerSeed': hex.encode(owner.seed),
        'master': hex.encode(master),
        'seed': hex.encode(seed),
        if (signed != null) 'signed': signed,
      };

  factory VaultKeys.fromJson(Map<String, dynamic> j) => VaultKeys(
        EdKey(Uint8List.fromList(hex.decode(j['ownerSeed'] as String))),
        Uint8List.fromList(hex.decode(j['master'] as String)),
        Uint8List.fromList(hex.decode(j['seed'] as String)),
        signed: j['signed'] as String?);

  Uint8List? _pk;
  Uint8List get pkHash => _pk ??= publicKeyHash(master, seed);

  /// Vault PDA and bump: seeds ["qcv", pk_hash, owner].
  Future<(String, int)> vault() async =>
      findProgramAddressWithBump([ascii.encode('qcv'), pkHash, pubkey(await owner.address())], qcProgram);

  /// The only token account the program lets this vault spend from (finding F9).
  Future<String> vaultTokenAccount(String mint) async => associatedTokenAddress((await vault()).$1, mint);
}

class SpendPlan {
  final Message prep, spend;
  final String digestHex;
  SpendPlan(this.prep, this.spend, this.digestHex);
}

/// Builds both transactions of a send: (1) create the recipient's and the next
/// vault's token accounts, (2) the hybrid-signed spend. Throws if the vault's
/// one-time key already signed a different message.
Future<SpendPlan> planSpend(EdKey payer, VaultKeys from, VaultKeys next, String recipient, BigInt amount,
    String blockhash, {required String mint}) async {
  final fee = await payer.address(), owner = await from.owner.address();
  final (vault, bump) = await from.vault();
  final vaultTa = await from.vaultTokenAccount(mint);
  final dest = associatedTokenAddress(recipient, mint);
  final (nextVault, _) = await next.vault();
  final nextTa = await next.vaultTokenAccount(mint);

  final digest = spendDigest(pubkey(qcProgram), pubkey(vault), pubkey(mint), pubkey(dest),
      pubkey(nextTa), pubkey(fee), amount);
  final dHex = hex.encode(digest);
  if (from.signed != null && from.signed != dHex) {
    throw StateError('This vault already signed a different transfer. Hash keys are one-time.');
  }
  final sig = wotsSign(from.master, from.seed, digest);

  final prep = Message.compile(fee, [
    createAtaIdempotent(fee, dest, recipient, mint),
    createAtaIdempotent(fee, nextTa, nextVault, mint),
  ], blockhash);
  final spend = Message.compile(fee, [
    setComputeUnitLimit(1400000),
    Ix(qcProgram, [
      Meta(vault, writable: true),
      Meta(vaultTa, writable: true),
      Meta(mint),
      Meta(dest, writable: true),
      Meta(nextTa, writable: true),
      Meta(fee, writable: true),
      const Meta(token2022),
      Meta(owner, signer: true),
      const Meta(systemProgram),
    ], [0, bump, ...from.seed, ...u64le(amount), ...sig]),
  ], blockhash);
  return SpendPlan(prep, spend, dHex);
}

/// Signs [m] with every key it needs and returns base64 wire bytes.
Future<String> signTx(Message m, List<EdKey> keys) async {
  final sigs = <String, List<int>>{};
  for (final k in keys) {
    final a = await k.address();
    if (m.signers.contains(a)) sigs[a] = await k.sign(m.bytes);
  }
  return base64.encode(serializeTx(m, sigs));
}
