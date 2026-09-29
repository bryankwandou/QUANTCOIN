// Legacy Solana transaction encoding, just enough for the vault flows.
import 'dart:typed_data';

import 'pda.dart';

class Meta {
  final String key;
  final bool signer, writable;
  const Meta(this.key, {this.signer = false, this.writable = false});
}

class Ix {
  final String program;
  final List<Meta> accounts;
  final List<int> data;
  const Ix(this.program, this.accounts, this.data);
}

const systemProgram = '11111111111111111111111111111111';
const computeBudget = 'ComputeBudget111111111111111111111111111111';

List<int> compactU16(int n) {
  final out = <int>[];
  while (true) {
    var b = n & 0x7f;
    n >>= 7;
    if (n == 0) {
      out.add(b);
      return out;
    }
    out.add(b | 0x80);
  }
}

Ix setComputeUnitLimit(int units) =>
    Ix(computeBudget, const [], [2, ...(ByteData(4)..setUint32(0, units, Endian.little)).buffer.asUint8List()]);

Ix createAtaIdempotent(String payer, String ata, String owner, String mint) => Ix(ataProgram, [
      Meta(payer, signer: true, writable: true),
      Meta(ata, writable: true),
      Meta(owner),
      Meta(mint),
      const Meta(systemProgram),
      const Meta(token2022),
    ], const [1]);

Ix transferSol(String from, String to, int lamports) => Ix(systemProgram, [
      Meta(from, signer: true, writable: true),
      Meta(to, writable: true),
    ], [2, 0, 0, 0, ...(ByteData(8)..setUint64(0, lamports, Endian.little)).buffer.asUint8List()]);

/// Compiles a legacy message. Account order: fee payer, then signer-writable,
/// signer-readonly, writable, readonly; each group keeps first-seen order.
class Message {
  final List<String> keys;
  final int nSigners, nReadonlySigned, nReadonlyUnsigned;
  final Uint8List bytes;
  Message._(this.keys, this.nSigners, this.nReadonlySigned, this.nReadonlyUnsigned, this.bytes);

  factory Message.compile(String payer, List<Ix> ixs, String blockhash) {
    final order = <String>[payer];
    final signer = <String, bool>{payer: true}, writable = <String, bool>{payer: true};
    void add(String k, bool s, bool w) {
      if (!order.contains(k)) order.add(k);
      signer[k] = (signer[k] ?? false) || s;
      writable[k] = (writable[k] ?? false) || w;
    }
    for (final ix in ixs) {
      for (final m in ix.accounts) {
        add(m.key, m.signer, m.writable);
      }
      add(ix.program, false, false);
    }
    int rank(String k) => k == payer ? 0 : (signer[k]! ? (writable[k]! ? 1 : 2) : (writable[k]! ? 3 : 4));
    final keys = [...order]..sort((a, b) {
        final r = rank(a).compareTo(rank(b));
        return r != 0 ? r : order.indexOf(a).compareTo(order.indexOf(b));
      });
    final nSig = keys.where((k) => signer[k]!).length;
    final nRoSig = keys.where((k) => signer[k]! && !writable[k]!).length;
    final nRoUn = keys.where((k) => !signer[k]! && !writable[k]!).length;
    final b = BytesBuilder()
      ..add([nSig, nRoSig, nRoUn])
      ..add(compactU16(keys.length));
    for (final k in keys) {
      b.add(b58decode(k).toList().let32());
    }
    b.add(b58decode(blockhash).toList().let32());
    b.add(compactU16(ixs.length));
    for (final ix in ixs) {
      b.add([keys.indexOf(ix.program)]);
      b.add(compactU16(ix.accounts.length));
      b.add([for (final m in ix.accounts) keys.indexOf(m.key)]);
      b.add(compactU16(ix.data.length));
      b.add(ix.data);
    }
    return Message._(keys, nSig, nRoSig, nRoUn, b.takeBytes());
  }

  List<String> get signers => keys.sublist(0, nSigners);
}

extension on List<int> {
  List<int> let32() {
    if (length == 32) return this;
    if (length > 32) throw FormatException('key longer than 32 bytes');
    return [...List.filled(32 - length, 0), ...this];
  }
}

/// Wire format: compact(sig count) + 64-byte signatures in signer order + message.
Uint8List serializeTx(Message m, Map<String, List<int>> sigs) {
  final b = BytesBuilder()..add(compactU16(m.nSigners));
  for (final k in m.signers) {
    final s = sigs[k];
    if (s == null || s.length != 64) throw StateError('missing signature for $k');
    b.add(s);
  }
  b.add(m.bytes);
  return b.takeBytes();
}
