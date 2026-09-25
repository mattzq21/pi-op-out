use super::{
    controller::{Host, Services},
    protocol::{kind, text, Result},
    providers::ProviderService,
    voice::VoiceService,
};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::{Arc, Weak};

pub(super) struct HostServices {
    providers: Arc<ProviderService>,
    voice: Arc<VoiceService>,
}

impl HostServices {
    pub fn new(executable: String) -> Arc<Self> {
        Arc::new(Self {
            providers: ProviderService::new(executable),
            voice: VoiceService::new(),
        })
    }
}

impl Services for HostServices {
    fn bind(&self, host: Weak<Host>) {
        self.providers.bind(host.clone());
        self.voice.bind(host);
    }
    fn handle(&self, packet: Value) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            match kind(&packet) {
                "voice" => self.voice.handle(packet).await,
                "provider_auth" => self.providers.handle(&text(&packet, "owner"), packet["request"].clone()).await,
                "provider_auth_cancel_owner" => {
                    self.providers.cancel_owner(&text(&packet, "owner")).await;
                    Ok(Value::Null)
                }
                _ => Err("Unknown host service operation".into()),
            }
        })
    }
    fn refresh_providers(&self) -> BoxFuture<'_, Result<u64>> {
        Box::pin(self.providers.check())
    }
    fn detach_voice<'a>(&'a self, runtime: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(self.voice.detach(runtime))
    }
    fn release_voice<'a>(&'a self, identity: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(self.voice.release(identity))
    }
    fn agent_event(&self, identity: &str, event: &Value) {
        self.voice.agent_event(identity, event);
    }
    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.voice.shutdown().await;
            self.providers.shutdown().await;
        })
    }
}
