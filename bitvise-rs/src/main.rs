//! bvrs binary: parse the CLI, run, propagate the exit code.

use clap::Parser;

fn main() -> std::process::ExitCode {
    let cli = bvrs::cli::Cli::parse();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("building tokio runtime");

    let code = match rt.block_on(bvrs::run(cli)) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("bvrs: {e:#}");
            1
        }
    };
    std::process::ExitCode::from(code.clamp(0, 255) as u8)
}
