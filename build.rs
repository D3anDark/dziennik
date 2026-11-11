//! Records whether this build is the official version, unchanged: BUILD_STATE is "official" (a clean working tree whose
//! commit is on a branch of the official repository), "modified", or "unknown" (no git to ask). BUILD_COMMIT is the
//! commit. The local clone can be made to lie about its remote branches, so the server asks GitHub again at start
//! (`confirm` in main.rs). A changed server can remove all of this, so it reveals honest changes only.

use std::path::Path;
use std::process::Command;

#[path = "src/provenance.rs"]
mod provenance;

fn git(args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    // GIT_DIR, GIT_WORK_TREE and the like would make git describe another, clean checkout than the one compiled.
    for (k, _) in std::env::vars_os().filter(|(k, _)| k.to_string_lossy().starts_with("GIT_")) {
        cmd.env_remove(k);
    }
    let out = cmd.args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Every tracked file, as it is on disk, is the one in the commit. `git status` alone trusts the index, whose flags
/// (assume-unchanged, skip-worktree) and saved file times can hide an edit; hashing the files cannot be told otherwise.
fn files_match_commit() -> bool {
    let Some(tree) = git(&["ls-tree", "-r", "-z", "HEAD"]) else { return false };
    let (paths, blobs): (Vec<&str>, Vec<&str>) = tree
        .split('\0')
        .filter_map(|entry| {
            let (meta, path) = entry.split_once('\t')?;
            let mut meta = meta.split(' ').skip(1);
            (meta.next()? == "blob").then_some((path, meta.next()?))
        })
        .unzip();
    let on_disk = git(&[&["hash-object", "--"][..], &paths].concat());
    !paths.is_empty() && on_disk.is_some_and(|h| h.lines().eq(blobs))
}

fn main() {
    // A path that does not exist would make cargo run this on every build.
    let watched = [
        ".git/HEAD", ".git/index", ".git/refs", ".git/packed-refs", "build.rs", "Cargo.toml", "Cargo.lock", "src", "deploy",
        "web/src", "web/public", "web/index.html", "web/package.json", "web/package-lock.json", "web/vite.config.js",
    ];
    for p in watched.iter().filter(|p| Path::new(p).exists()) {
        println!("cargo:rerun-if-changed={p}");
    }
    let commit = git(&["rev-parse", "HEAD"]).unwrap_or_default();
    let state = if commit.is_empty() {
        "unknown"
    } else {
        // Untracked files count: a new source file changes the code as much as an edited one.
        // --untracked-files=all overrides a status.showUntrackedFiles=no that would hide them.
        let clean = git(&["status", "--porcelain", "--untracked-files=all"]).is_some_and(|s| s.is_empty())
            && files_match_commit();
        let remotes = git(&["remote", "-v"]).unwrap_or_default();
        let official: Vec<&str> = remotes
            .lines()
            .filter_map(|l| l.split_once('\t'))
            .filter(|(_, url)| provenance::official(url.split(' ').next().unwrap_or_default()))
            .map(|(name, _)| name)
            .collect();
        // shortcut: the remote branches are as fresh as the last fetch; a commit pushed since reads as modified until then.
        let published = git(&["branch", "-r", "--contains", "HEAD"])
            .is_some_and(|b| b.lines().any(|l| official.iter().any(|r| l.trim().starts_with(&format!("{r}/")))));
        if clean && published { "official" } else { "modified" }
    };
    println!("cargo:rustc-env=BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=BUILD_STATE={state}");
}
