//! Connection establishment and authentication.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use russh::client::{self, Handle};
use russh::keys::ssh_key::HashAlg;
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate, load_secret_key};

use crate::cli::AuthOpts;
use crate::dest::Destination;
use crate::hostkeys;

/// russh client handler performing host key verification.
pub struct ClientHandler {
    policy: hostkeys::HostKeyPolicy,
    known_hosts: std::path::PathBuf,
    /// Fingerprints pinned via -hostKeyFp= / -hostKeyFile=; when non-empty
    /// they replace known_hosts checking (Bitvise semantics).
    pinned: Vec<String>,
    host: String,
    port: u16,
}

impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key().clone().into(),
        };

        if !self.pinned.is_empty() {
            let sha256 = key.fingerprint(HashAlg::Sha256).to_string();
            let matches = self
                .pinned
                .iter()
                .any(|p| normalize_fp(p) == normalize_fp(&sha256));
            if !matches {
                return Err(anyhow!(
                    "server host key fingerprint {sha256} does not match -hostKeyFp"
                ));
            }
            return Ok(true);
        }

        hostkeys::confirm_and_record(self.policy, &self.known_hosts, &self.host, self.port, &key)
            .map(|()| true)
            .map_err(|e| anyhow!("host key verification failed: {e:#}"))
    }
}

/// Compare fingerprints ignoring the `SHA256:` prefix and case.
fn normalize_fp(fp: &str) -> String {
    fp.trim().trim_start_matches("SHA256:").to_ascii_lowercase()
}

/// Connect to `dest` and authenticate (identities first, then password).
pub async fn connect(opts: &AuthOpts, dest: &Destination) -> Result<Handle<ClientHandler>> {
    let port = dest.port.unwrap_or(22);
    let config = Arc::new(client::Config::default());
    let handler = ClientHandler {
        policy: opts.host_key_policy,
        known_hosts: opts.known_hosts.clone(),
        pinned: opts.pinned_fingerprints.clone(),
        host: dest.host.clone(),
        port,
    };

    let connect_fut = client::connect(config, (dest.host.as_str(), port), handler);
    let mut handle = tokio::time::timeout(Duration::from_secs(opts.connect_timeout), connect_fut)
        .await
        .map_err(|_| anyhow!("connection to {}:{} timed out", dest.host, port))?
        .with_context(|| format!("connecting to {}:{}", dest.host, port))?;

    // Public key authentication: try each identity in order.
    for path in &opts.identities {
        let key = load_secret_key(path, opts.identity_passphrase.as_deref())
            .with_context(|| format!("loading identity {}", path.display()))?;
        let auth = authenticate_publickey(&mut handle, &dest.user, key).await?;
        if auth {
            return Ok(handle);
        }
        eprintln!("bvrs: identity {} rejected", path.display());
    }

    // Password authentication: -pw=, then --password-env, then a prompt.
    let password = match (&opts.password, &opts.password_env) {
        (Some(pw), _) => pw.clone(),
        (None, Some(var)) => std::env::var(var).map_err(|_| {
            anyhow!("environment variable {var:?} (from --password-env) is not set")
        })?,
        (None, None) => {
            rpassword::prompt_password("password: ").context("reading password from terminal")?
        }
    };
    let auth = handle
        .authenticate_password(&dest.user, &password)
        .await
        .context("password authentication request failed")?;
    if auth.success() {
        return Ok(handle);
    }
    bail!("permission denied for {}@{}:{}", dest.user, dest.host, port);
}

async fn authenticate_publickey(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    key: PrivateKey,
) -> Result<bool> {
    let rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .context("querying server RSA preferences")?
        .flatten();
    let auth = handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash))
        .await
        .context("publickey authentication request failed")?;
    Ok(auth.success())
}
