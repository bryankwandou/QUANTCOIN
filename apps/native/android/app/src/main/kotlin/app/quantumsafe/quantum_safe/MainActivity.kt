package app.quantumsafe.quantum_safe

// local_auth needs a FragmentActivity: with a plain FlutterActivity every
// fingerprint/PIN prompt fails and no send can ever be confirmed.
import io.flutter.embedding.android.FlutterFragmentActivity

class MainActivity : FlutterFragmentActivity()
