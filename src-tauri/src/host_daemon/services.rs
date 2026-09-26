use super::{
    controller::{Host, Services},
    protocol::{kind, text, Result},
    providers::ProviderService,
};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::{Arc, Weak};

pub(super) struct HostServices {
    providers: Arc<ProviderService>,
}

impl HostServices {
    pub fn new(executable: String) -> Arc<Self> {
        Arc::new(Self {
            providers: ProviderService::new(executable),
        })
    }
}

impl Services for HostServices {
    fn bind(&self, host: Weak<Host>) {
        self.providers.bind(host);
    }
    fn handle(&self, packet: Value) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            match kind(&packet) {
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
    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.providers.shutdown().await;
        })
    }
}
