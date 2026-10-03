import 'chain.dart';
import 'pda.dart';
import 'wallet.dart';

enum SendStep { preparing, accounts, signing, sending, done }

/// Owners of accounts nobody can sign for: tokens sent to them never move again.
const _deadOwners = {
  'BPFLoaderUpgradeab1e11111111111111111111111', 'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111', 'NativeLoader1111111111111111111111111111111',
  'LoaderV411111111111111111111111111111111111', 'Sysvar1111111111111111111111111111111111111',
};
const _incinerator = '1nc1nerator11111111111111111111111111111111';

/// Token-2022 associated account with the ImmutableOwner extension.
const ataBytes = 170;

/// Lamports the fee key needs for a send: up to two new token accounts plus
/// three signatures (prep: 1, spend: fee key + vault owner).
Future<int> sendCost(Chain chain, VaultKeys next, String recipient) async {
  var missing = 0;
  for (final a in [associatedTokenAddress(recipient, chain.mint), await next.vaultTokenAccount(chain.mint)]) {
    if (await chain.accountOwner(a) == null) missing++;
  }
  return missing * await chain.rentExempt(ataBytes) + 3 * 5000;
}

/// Refuses a send the program would reject, BEFORE the one-time key signs it.
/// Once that signature is broadcast the key may never sign anything else, so a
/// doomed transfer (too much, own vault, bad address) would lock the vault for good.
Future<void> checkSpend(Chain chain, VaultKeys from, VaultKeys next, String recipient, BigInt amount,
    {String? fee}) async {
  pubkey(recipient); // throws on anything that isn't exactly 32 bytes
  final vault = (await from.vault()).$1;
  if (recipient == vault || recipient == (await next.vault()).$1) {
    throw StateError('That is this wallet\'s own vault. Send to another address.');
  }
  if (amount <= BigInt.zero) throw StateError('Amount must be above zero.');
  if (await chain.accountOwner(vault) == qcProgram) throw StateError('This vault was already spent.');
  final held = await chain.tokenAmount(await from.vaultTokenAccount(chain.mint));
  if (amount > held) throw StateError('The vault holds only ${fmtUnits(held)} QC.');
  final kind = await chain.accountOwner(recipient);
  if (kind == token2022 || kind == tokenProgram) {
    throw StateError('That is a token account or mint, not a wallet address. Use the wallet address.');
  }
  if (kind == qcProgram) throw StateError('That vault was already spent; anything sent to it is locked forever.');
  if (_deadOwners.contains(kind) || recipient == _incinerator) {
    throw StateError('That address is a program, not a wallet. Tokens sent there can never move again.');
  }
  if (fee != null) {
    final need = await sendCost(chain, next, recipient), have = await chain.solBalance(fee);
    if (have < need) {
      throw StateError('The fee key needs ${(need / 1e9).toStringAsFixed(6)} SOL for this send '
          'and holds ${(have / 1e9).toStringAsFixed(6)}. Send SOL to $fee first.');
    }
  }
}

/// Full send: create token accounts, then the hybrid-signed spend.
/// [persist] MUST durably store `from` and `next` before it returns. It runs
/// twice: before anything is broadcast (saves `next`, which receives the
/// remainder), and once `from.signed` is set, right before the one-time
/// signature leaves the device. Until then an unfinished send can be dropped.
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
  // A resume re-signs the recorded digest; planSpend refuses any other one.
  if (from.signed == null) await checkSpend(chain, from, next, recipient, amount, fee: await payer.address());
  var bh = await chain.latestBlockhash();
  var plan = await planSpend(payer, from, next, recipient, amount, bh, mint: chain.mint);
  await persist();

  onStep?.call(SendStep.accounts);
  final prepSig = await chain.send(await signTx(plan.prep, [payer]));
  await chain.confirm(prepSig);

  onStep?.call(SendStep.signing);
  bh = await chain.latestBlockhash();
  plan = await planSpend(payer, from, next, recipient, amount, bh, mint: chain.mint); // same digest, fresh blockhash
  final wire = await signTx(plan.spend, [payer, from.owner]);
  from.signed = plan.digestHex;
  await persist();

  onStep?.call(SendStep.sending);
  final sig = await chain.send(wire);
  await chain.confirm(sig);
  onStep?.call(SendStep.done);
  return sig;
}
