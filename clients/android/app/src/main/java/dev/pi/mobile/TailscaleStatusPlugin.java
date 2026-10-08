package dev.pi.mobile;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "TailscaleStatus")
public class TailscaleStatusPlugin extends Plugin {
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
        ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        boolean vpnActive = false;
        boolean tailscaleNetwork = false;
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            vpnActive = true;
            tailscaleNetwork |= hasTailscaleAddress(manager.getLinkProperties(network));
        }
        JSObject result = new JSObject();
        result.put("state", launchIntent() == null ? "missing" : tailscaleNetwork ? "active" : vpnActive ? "other-vpn" : "off");
        call.resolve(result);
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
