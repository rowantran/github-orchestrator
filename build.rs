//! Records the commit `gho` is built from, so `gho doctor` can compare it with the published one.
//! `cargo install --git` builds from a Git checkout, so the commit is available there too.

use std::path::Path;
use std::process::Command;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let git = |args: &[&str]| -> Option<String> {
        let output = Command::new("git").args(args).current_dir(dir).output().ok()?;
        let text = String::from_utf8(output.stdout).ok()?.trim().to_owned();
        (output.status.success() && !text.is_empty()).then_some(text)
    };
    // Rebuild when HEAD moves: a checkout, or a commit on the checked-out branch. Cargo reruns the
    // script on every build for a missing path, so a packed branch ref is watched through its
    // nearest existing directory under refs/; a directory counts as changed when a file in it does.
    let git_path = |name: &str| git(&["rev-parse", "--path-format=absolute", "--git-path", name]);
    let mut watched: Vec<String> = git_path("HEAD").into_iter().collect();
    if let Some(branch) = git(&["symbolic-ref", "-q", "HEAD"]) {
        let mut name = branch.as_str();
        while let Some(path) = git_path(name) {
            if Path::new(&path).exists() || !name.contains('/') {
                watched.push(path);
                break;
            }
            name = name.rsplit_once('/').map_or("", |(parent, _)| parent);
        }
    }
    watched.extend(git_path("packed-refs").filter(|path| Path::new(path).exists()));
    for path in watched {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rustc-env=GHO_COMMIT={}", git(&["rev-parse", "HEAD"]).unwrap_or_default());
}
