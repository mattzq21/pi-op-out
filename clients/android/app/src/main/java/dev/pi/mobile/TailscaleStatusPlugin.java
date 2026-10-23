package dev.pi.mobile;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.util.Log;
import java.util.HashMap;
import java.util.Map;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "TailscaleStatus")
public class TailscaleStatusPlugin extends Plugin {
    private ConnectivityManager manager;
    private ConnectivityManager.NetworkCallback callback;
    private final Map<Network, Boolean> networks = new HashMap<>();
    private String monitoringError;
    private String publishedState;

    @Override
    public void load() {
        manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        ConnectivityManager.NetworkCallback listener = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { update(network, false); }
            @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) { update(network, hasTailscaleAddress(properties)); }
            @Override public void onLost(Network network) {
                synchronized (networks) { networks.remove(network); publish(); }
            }
        };
        try {
            manager.registerNetworkCallback(new NetworkRequest.Builder().clearCapabilities().addTransportType(NetworkCapabilities.TRANSPORT_VPN).build(), listener);
            callback = listener;
        } catch (RuntimeException error) {
            monitoringError = "Could not watch VPN changes: " + error;
            Log.e("TailscaleStatus", monitoringError, error);
        }
    }

    private void update(Network network, boolean tailscale) {
        synchronized (networks) { networks.put(network, tailscale); publish(); }
    }

    private JSObject status(boolean vpn, boolean tailscale) {
        JSObject result = new JSObject();
        result.put("state", launchIntent() == null ? "missing" : tailscale ? "active" : vpn ? "other-vpn" : "off");
        return result;
    }

    private void publish() {
        try {
            JSObject result = status(!networks.isEmpty(), networks.containsValue(true));
            String state = result.getString("state");
            if (state.equals(publishedState)) return;
            publishedState = state;
            notifyListeners("statusChanged", result);
        } catch (RuntimeException error) {
            JSObject result = new JSObject();
            result.put("state", "unknown"); result.put("error", "Could not read VPN status: " + error);
            publishedState = null;
            notifyListeners("statusChanged", result);
            Log.e("TailscaleStatus", "Could not read VPN status", error);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (callback != null) {
            try { manager.unregisterNetworkCallback(callback); }
            catch (RuntimeException error) { Log.e("TailscaleStatus", "Could not stop watching VPN changes", error); }
            callback = null;
        }
        super.handleOnDestroy();
    }

    private Intent launchIntent() {
        return getContext().getPackageManager().getLaunchIntentForPackage("com.tailscale.ipn");
    }

    private boolean hasTailscaleAddress(LinkProperties properties) {
        if (properties == null) return false;
        for (LinkAddress address : properties.getLinkAddresses()) {
            byte[] bytes = address.getAddress().getAddress();
            if (bytes.length == 4 && (bytes[0] & 255) == 100
                    && (bytes[1] & 255) >= 64 && (bytes[1] & 255) <= 127) return true;
            if (bytes.length == 16 && (bytes[0] & 255) == 0xfd && (bytes[1] & 255) == 0x7a
                    && (bytes[2] & 255) == 0x11 && (bytes[3] & 255) == 0x5c
                    && (bytes[4] & 255) == 0xa1 && (bytes[5] & 255) == 0xe0) return true;
        }
        return false;
    }

    @PluginMethod
    public void check(PluginCall call) {
        if (monitoringError != null) { call.reject(monitoringError); return; }
        try {
            boolean vpnActive = false;
            boolean tailscaleNetwork = false;
            for (Network network : manager.getAllNetworks()) {
                NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
                if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
                vpnActive = true;
                tailscaleNetwork |= hasTailscaleAddress(manager.getLinkProperties(network));
            }
            call.resolve(status(vpnActive, tailscaleNetwork));
        } catch (RuntimeException error) { call.reject("Could not read VPN status", error); }
    }

    @PluginMethod
    public void open(PluginCall call) {
        Intent intent = launchIntent();
        if (intent == null) {
            call.reject("Tailscale is not installed on this device.");
            return;
        }
        getActivity().startActivity(intent);
        call.resolve();
    }
}
