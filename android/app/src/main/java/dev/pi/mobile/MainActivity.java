package dev.pi.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClientPreferencesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
