//! The installed `gho` commit and the published one. Every commit on the published branch is a new version.

use crate::process::{Cmd, Runner};
use crate::{Error, Result};

/// Where `gho` is published, from `repository` in Cargo.toml.
pub const REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");
/// The branch that holds the published version.
pub const BRANCH: &str = "main";

/// The commit this binary was built from, or `None` when the build had no Git checkout.
pub fn installed() -> Option<&'static str> {
    Some(env!("GHO_COMMIT")).filter(|commit| !commit.is_empty())
}

/// The commit at the tip of the published branch, read without cloning or GitHub credentials.
pub fn published(runner: &dyn Runner) -> Result<String> {
    let reference = format!("refs/heads/{BRANCH}");
    let output = runner.run(&Cmd::new(["git", "ls-remote", REPOSITORY, reference.as_str()]).timeout(20))?;
    output
        .lines()
        .find_map(|line| line.split_once('\t').filter(|(_, name)| *name == reference).map(|(commit, _)| commit))
        .map(str::to_owned)
        .ok_or_else(|| Error::msg(format!("{REPOSITORY} has no branch {BRANCH}.")))
}

/// The `gho doctor` line comparing the installed and published commits. Never a failure: an outdated
/// or unknown version still works.
pub fn report(installed: Option<&str>, published: Result<String>) -> String {
    let short = |commit: &str| commit.chars().take(12).collect::<String>();
    match (installed, published) {
        (_, Err(error)) => format!("WARN gho version: cannot read the published version: {error}"),
        (None, Ok(_)) => format!("WARN gho version: unknown (built without Git); to update, {}", update_hint()),
        (Some(installed), Ok(published)) if installed == published => {
            format!("OK   gho version: {} (latest on {BRANCH})", short(installed))
        }
        (Some(installed), Ok(published)) => format!(
            "WARN gho version: {} is installed, but {BRANCH} is at {}; to update, {}",
            short(installed),
            short(&published),
            update_hint()
        ),
    }
}

fn update_hint() -> String {
    let package = REPOSITORY.trim_start_matches("https://");
    format!("run: cargo install --locked --git {REPOSITORY} && pi update git:{package}")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct LsRemote(&'static str);

    impl Runner for LsRemote {
        fn run(&self, cmd: &Cmd) -> Result<String> {
            assert_eq!(cmd.argv, ["git", "ls-remote", REPOSITORY, "refs/heads/main"]);
            Ok(self.0.into())
        }
    }

    const OLD: &str = "1111111111111111111111111111111111111111";
    const NEW: &str = "2222222222222222222222222222222222222222";

    #[test]
    fn reads_the_published_commit() {
        let output = format!("{NEW}\trefs/heads/main\n");
        assert_eq!(published(&LsRemote(output.leak())).unwrap(), NEW);
        assert!(published(&LsRemote("")).is_err());
    }

    #[test]
    fn reports_the_latest_version() {
        assert_eq!(report(Some(NEW), Ok(NEW.into())), "OK   gho version: 222222222222 (latest on main)");
    }

    #[test]
    fn tells_you_to_update_when_the_commits_differ() {
        let line = report(Some(OLD), Ok(NEW.into()));
        assert!(
            line.starts_with("WARN gho version: 111111111111 is installed, but main is at 222222222222;"),
            "{line}"
        );
        assert!(
            line.contains("cargo install --locked --git https://github.com/rowantran/github-orchestrator"),
            "{line}"
        );
        assert!(line.ends_with("pi update git:github.com/rowantran/github-orchestrator"), "{line}");
    }

    #[test]
    fn warns_when_a_version_is_unknown() {
        assert!(report(None, Ok(NEW.into())).starts_with("WARN gho version: unknown"));
        let line = report(Some(OLD), Err(Error::msg("offline")));
        assert_eq!(line, "WARN gho version: cannot read the published version: offline");
    }

    #[test]
    fn records_the_build_commit() {
        // Tests build from this repository's checkout, so the commit is known.
        assert!(installed().is_some_and(|commit| commit.len() == 40), "{:?}", installed());
    }
}
