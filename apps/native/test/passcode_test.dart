// Without biometrics the passcode is the only gate before a send, so guessing
// it must not be free.
import 'package:flutter_test/flutter_test.dart';
import 'package:quantum_safe/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('five wrong passcodes lock the keypad, even for the right one', () async {
    SharedPreferences.setMockInitialValues({});
    final s = AppState(await SharedPreferences.getInstance());
    s.setCode('135790');
    for (var i = 0; i < 4; i++) {
      expect(s.checkCode('000000'), isFalse);
    }
    expect(s.codeLock, Duration.zero);
    expect(s.checkCode('135790'), isTrue, reason: 'four misses do not lock');
    for (var i = 0; i < 5; i++) {
      expect(s.checkCode('000000'), isFalse);
    }
    expect(s.codeLock, greaterThan(const Duration(seconds: 25)));
    expect(s.checkCode('135790'), isFalse, reason: 'locked');
  });
}
