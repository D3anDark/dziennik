//! The official repository. Shared with build.rs, which decides the build's state, and main.rs, which asks GitHub.

/// The project's own repository; a build from anywhere else is not the official version.
pub const OFFICIAL: &str = "github.com/d3andark/dziennik";

/// Matches the official repository whatever the form of its URL: https, ssh, scp-like, with credentials or `.git`.
#[allow(dead_code)] // build.rs's; the server itself needs only OFFICIAL
pub fn official(url: &str) -> bool {
    let url = url.trim().to_lowercase();
    let url = url.trim_end_matches('/').trim_end_matches(".git");
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host_path = rest.rsplit_once('@').map_or(rest, |(_, after)| after);
    host_path.replacen(':', "/", 1) == OFFICIAL
}

#[cfg(test)]
mod tests {
    use super::official;

    #[test]
    fn remote_urls() {
        for url in [
            "https://github.com/D3anDark/dziennik.git",
            "https://github.com/D3anDark/dziennik/",
            "git@github.com:D3anDark/dziennik.git",
            "ssh://git@github.com/D3anDark/dziennik",
            "https://user:token@github.com/d3andark/dziennik",
        ] {
            assert!(official(url), "{url}");
        }
        for url in [
            "https://github.com/someone/dziennik.git",
            "https://github.com/D3anDark/dziennik-fork",
            "https://evil.example/github.com/d3andark/dziennik",
            "",
        ] {
            assert!(!official(url), "{url}");
        }
    }
}
