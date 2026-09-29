import 'chain.dart';
import 'wallet.dart';

enum SendStep { preparing, accounts, signing, sending, done }

/// Full send: create token accounts, then the hybrid-signed spend.
/// [persist] MUST durably store `from` (with its signed digest) and `next`
/// before this returns from the await — it runs before anything is broadcast,
/// so a crash never loses the one-time key record or the remainder's keys.
Future<String> sendQc({
  required Chain chain,
  required EdKey payer,
  required VaultKeys from,
  required VaultKeys next,
  required String recipient,
  required BigInt amount,
  required Future<void> Function() persist,
  void Function(SendStep)? onStep,
}) async {
  onStep?.call(SendStep.preparing);
  var bh = await chain.latestBlockhash();
  var plan = await planSpend(payer, from, next, recipient, amount, bh);
  from.signed = plan.digestHex;
  await persist();

  onStep?.call(SendStep.accounts);
  final prepSig = await chain.send(await signTx(plan.prep, [payer]));
  await chain.confirm(prepSig);

  onStep?.call(SendStep.signing);
  bh = await chain.latestBlockhash();
  plan = await planSpend(payer, from, next, recipient, amount, bh); // same digest, fresh blockhash
  final wire = await signTx(plan.spend, [payer, from.owner]);

  onStep?.call(SendStep.sending);
  final sig = await chain.send(wire);
  await chain.confirm(sig);
  onStep?.call(SendStep.done);
  return sig;
}
