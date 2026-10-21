//! Destination string parsing: `[user@]host[:port]`, IPv6 in brackets.

use anyhow::{Result, bail};

/// A parsed `[user@]host[:port]` destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Destination {
    pub user: String,
    pub host: String,
    /// `None` when no port is given; resolved against the CLI `-p` and 22.
    pub port: Option<u16>,
}

impl Destination {
    /// Parse a destination string.
    ///
    /// Accepted forms: `host`, `user@host`, `host:port`, `user@host:port`,
    /// `[2001:db8::1]`, `[2001:db8::1]:2222`, `user@[2001:db8::1]:2222`,
    /// and bare `2001:db8::1` (IPv6 without brackets, no port).
    pub fn parse(s: &str) -> Result<Self> {
        let s = s.trim();
        if s.is_empty() {
            bail!("empty destination");
        }

        let (user, hostport) = match s.rfind('@') {
            Some(at) => (Some(&s[..at]), &s[at + 1..]),
            None => (None, s),
        };
        if user.is_some_and(str::is_empty) {
            bail!("empty user in destination {s:?}");
        }
        if hostport.is_empty() {
            bail!("empty host in destination {s:?}");
        }

        // Bracketed IPv6 (optionally followed by :port).
        if let Some(rest) = hostport.strip_prefix('[') {
            let Some((host, tail)) = rest.split_once(']') else {
                bail!("unterminated '[' in destination {s:?}");
            };
            let port = match tail {
                "" => None,
                t => Some(parse_port(t, s)?),
            };
            return Ok(Self::complete(user, host, port));
        }

        // Bare IPv6 contains several ':' and no parseable trailing port.
        if hostport.matches(':').count() > 1 {
            return Ok(Self::complete(user, hostport, None));
        }

        let (host, port) = match hostport.rsplit_once(':') {
            Some((h, p)) => (h, Some(parse_port(&format!(":{p}"), s)?)),
            None => (hostport, None),
        };
        if host.is_empty() {
            bail!("empty host in destination {s:?}");
        }
        Ok(Self::complete(user, host, port))
    }

    fn complete(user: Option<&str>, host: &str, port: Option<u16>) -> Self {
        Self {
            user: user.map(str::to_owned).unwrap_or_else(local_username),
            host: host.to_owned(),
            port,
        }
    }
}

fn parse_port(tail: &str, whole: &str) -> Result<u16> {
    let Some(p) = tail.strip_prefix(':') else {
        bail!("unexpected {tail:?} after ']' in destination {whole:?}");
    };
    let port = p
        .parse::<u16>()
        .map_err(|_| anyhow::anyhow!("invalid port {p:?} in destination {whole:?}"))?;
    if port == 0 {
        bail!("port 0 is not valid in destination {whole:?}");
    }
    Ok(port)
}

fn local_username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "root".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_only() {
        let d = Destination::parse("example.com").unwrap();
        assert_eq!(d.host, "example.com");
        assert_eq!(d.port, None);
        assert!(!d.user.is_empty());
    }

    #[test]
    fn user_host_port() {
        let d = Destination::parse("alice@example.com:2222").unwrap();
        assert_eq!(d.user, "alice");
        assert_eq!(d.host, "example.com");
        assert_eq!(d.port, Some(2222));
    }

    #[test]
    fn ipv6_bracketed() {
        let d = Destination::parse("bob@[2001:db8::1]:22").unwrap();
        assert_eq!(d.user, "bob");
        assert_eq!(d.host, "2001:db8::1");
        assert_eq!(d.port, Some(22));
    }

    #[test]
    fn ipv6_bare() {
        let d = Destination::parse("::1").unwrap();
        assert_eq!(d.host, "::1");
        assert_eq!(d.port, None);
    }

    #[test]
    fn rejects_bad_port() {
        assert!(Destination::parse("h:notaport").is_err());
        assert!(Destination::parse("h:0").is_err());
        assert!(Destination::parse("@host").is_err());
    }
}
