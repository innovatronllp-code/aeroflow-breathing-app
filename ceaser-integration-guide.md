# Ceaser App Integration Guide: AeroFlow Breathing Spirometer

This guide provides instructions and copy-paste code snippets to embed and interact with the **AeroFlow Breathing Spirometer** inside the **Ceaser App** (via HTML iframe, Flutter WebView, or React Native WebView).

---

## 1. Quick HTML / Web iframe Integration

When embedding AeroFlow into a web-based dashboard or web view inside the Ceaser app:

```html
<!-- Important: allow="microphone" is strictly required for breath detection -->
<iframe
  id="aeroflow-frame"
  src="https://innovatronllp-code.github.io/aeroflow-breathing-app/"
  style="width: 100%; height: 900px; border: none; border-radius: 16px; overflow: hidden;"
  allow="microphone"
  allowfullscreen>
</iframe>

<script>
  // 1. Listen for breathing metrics emitted by AeroFlow
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'aeroflow') return;

    switch (data.type) {
      case 'AEROFLOW_READY':
        console.log('AeroFlow is ready. Initial config:', data.payload);
        break;

      case 'AEROFLOW_REP_COMPLETE':
        console.log(`Repetition ${data.payload.rep} complete:`, data.payload);
        // data.payload: { rep: 1, lpi: 85, peak: 92, stability: 88, sustained: 4.2 }
        break;

      case 'AEROFLOW_SESSION_COMPLETE':
        console.log('Full breathing session complete! Saving to patient record:', data.payload);
        /*
          data.payload:
          {
            date: "2026-09-29",
            timestamp: 1727554800000,
            mode: "exhale",
            difficulty: "easy",
            lpi: 84,             // Overall Lung Performance Index (0-100)
            peak: 90,            // Peak capacity percentage
            sustained: "4.1",    // Sustained flow seconds
            stability: 86,       // Flow steadiness percentage
            volume: "4.24"       // Estimated vital capacity in Liters
          }
        */
        saveToCeaserDatabase(data.payload);
        break;
    }
  });

  // 2. Send commands to AeroFlow from the Ceaser App
  function sendCommandToAeroFlow(type, payload = {}) {
    const frame = document.getElementById('aeroflow-frame');
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type, ...payload }, '*');
    }
  }

  // Example helper controls:
  // sendCommandToAeroFlow('AEROFLOW_SET_MODE', { mode: 'inhale' });
  // sendCommandToAeroFlow('AEROFLOW_SET_DIFFICULTY', { difficulty: 'medium' });
  // sendCommandToAeroFlow('AEROFLOW_START_SESSION');
  // sendCommandToAeroFlow('AEROFLOW_STOP_SESSION');
</script>
```

---

## 2. Flutter Mobile Integration (`webview_flutter`)

For Flutter applications, use `webview_flutter` with permission configuration:

### Dependencies (`pubspec.yaml`):
```yaml
dependencies:
  flutter:
    sdk: flutter
  webview_flutter: ^4.7.0
  permission_handler: ^11.3.0
```

### Android Permissions (`android/app/src/main/AndroidManifest.xml`):
```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

### Flutter Widget Code:
```dart
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:permission_handler/permission_handler.dart';

class AeroFlowExerciseScreen extends StatefulWidget {
  final String hostedUrl;
  const AeroFlowExerciseScreen({Key? key, required this.hostedUrl}) : super(key: key);

  @override
  State<AeroFlowExerciseScreen> createState() => _AeroFlowExerciseScreenState();
}

class _AeroFlowExerciseScreenState extends State<AeroFlowExerciseScreen> {
  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    _requestMicrophone();

    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel(
        'CeaserChannel',
        onMessageReceived: (JavaScriptMessage message) {
          final data = jsonDecode(message.message);
          _handleAeroFlowEvent(data);
        },
      )
      ..loadRequest(Uri.parse(widget.hostedUrl));
  }

  Future<void> _requestMicrophone() async {
    await Permission.microphone.request();
  }

  void _handleAeroFlowEvent(Map<String, dynamic> data) {
    if (data['type'] == 'AEROFLOW_SESSION_COMPLETE') {
      final payload = data['payload'];
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Session Logged! LPI Score: ${payload['lpi']}%')),
      );
      // Save to Ceaser patient health record
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Lung Capacity Training')),
      body: WebViewWidget(controller: _controller),
    );
  }
}
```

---

## 3. React Native Mobile Integration (`react-native-webview`)

For React Native applications:

### Component Code:
```tsx
import React, { useRef } from 'react';
import { StyleSheet, View, Alert } from 'react-native';
import { WebView } from 'react-native-webview';

export const CeaserBreathingScreen = ({ hostedUrl }: { hostedUrl: string }) => {
  const webViewRef = useRef<WebView>(null);

  const onMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'AEROFLOW_SESSION_COMPLETE') {
        Alert.alert(
          'Exercise Complete',
          `Your Lung Performance Index: ${data.payload.lpi}%\nEstimated Volume: ${data.payload.volume}L`
        );
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: hostedUrl }}
        originWhitelist={['*']}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        onMessage={onMessage}
        style={styles.webview}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#070913' },
  webview: { flex: 1 },
});
```

---

## 4. Summary of Supported Bridge Messages

### From AeroFlow to Ceaser Host (`emitToHost`):
| Event Type | Payload Attributes | Description |
| :--- | :--- | :--- |
| `AEROFLOW_READY` | `{ mode, difficulty }` | Fired when AeroFlow finishes loading and initializing. |
| `AEROFLOW_REP_COMPLETE` | `{ rep, lpi, peak, stability, sustained }` | Fired at the end of each breath cycle (5 per session). |
| `AEROFLOW_SESSION_COMPLETE` | `{ date, timestamp, mode, difficulty, lpi, peak, sustained, stability, volume }` | Fired when the full session is finalized and calculated. |
| `AEROFLOW_MODE_CHANGED` | `{ mode }` | Informs host when user toggles Inhale or Exhale. |
| `AEROFLOW_DIFFICULTY_CHANGED`| `{ difficulty }` | Informs host when user adjusts Easy / Medium / Hard. |
| `AEROFLOW_STATS_RESPONSE` | `{ logs, streak, lastSession }` | Emitted in response to `AEROFLOW_GET_STATS`. |
| `AEROFLOW_PONG` | `{ version, mode, difficulty, sessionState }` | Heartbeat health check. |

### From Ceaser Host to AeroFlow (`postMessage`):
| Action / Type | Parameters | Description |
| :--- | :--- | :--- |
| `AEROFLOW_SET_MODE` | `{ mode: 'inhale' \| 'exhale' }` | Changes the exercise mode programmatically. |
| `AEROFLOW_SET_DIFFICULTY` | `{ difficulty: 'easy' \| 'medium' \| 'hard' }` | Changes the target threshold levels. |
| `AEROFLOW_START_SESSION` | `{}` | Starts a new 5-repetition guided breathing set. |
| `AEROFLOW_STOP_SESSION` | `{}` | Halts the current active training session. |
| `AEROFLOW_GET_STATS` | `{}` | Requests full training history and streak from localStorage. |
| `AEROFLOW_PING` | `{}` | Requests state check response (`AEROFLOW_PONG`). |
