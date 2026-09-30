use std::process::ExitCode;

fn main() -> ExitCode {
    let code = github_orchestrator::cli::main(std::env::args_os());
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
