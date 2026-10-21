//! bvrs binary: parse the CLI (native + Bitvise-style options), run,
//! propagate the exit code.

use clap::Parser;

fn main() -> std::process::ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();

    // Extract Bitvise-style -option=value arguments before clap sees them.
    let (rest, bvc) = match bvrs::bvc::extract(&raw) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("bvrs: {e:#}");
            return std::process::ExitCode::from(2);
        }
    };

    let cli = match bvrs::cli::Cli::try_parse_from(std::iter::once("bvrs".to_owned()).chain(rest)) {
        Ok(cli) => cli,
        Err(e) => {
            e.print().ok();
            return std::process::ExitCode::from(e.exit_code().clamp(0, 255) as u8);
        }
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("building tokio runtime");

    let code: i32 = match rt.block_on(bvrs::run(cli, bvc)) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("bvrs: {e:#}");
            1
        }
    };
    std::process::ExitCode::from(code.clamp(0, 255) as u8)
}
