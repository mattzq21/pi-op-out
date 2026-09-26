package dev.pi.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClientPreferencesPlugin.class);
        super.onCreate(savedInstanceState);
        // A voice call is explicitly started in Piop; its remote audio track arrives asynchronously.
        bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    }
}
