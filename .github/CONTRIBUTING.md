# Contributing

Thanks for your interest in Doftar! It's built by one person in spare time,
so replies can take a week or more.

Everyone taking part follows the
[Code of Conduct](https://github.com/mhbsiam/doftar/blob/main/.github/CODE_OF_CONDUCT.md).

## Bug reports

Bug reports help the most. Please use the **Bug report** form and include:

- the Doftar version (**Doftar → About Doftar**)
- your macOS version
- what you did, what you expected and what happened
- a screenshot or recording, if it helps

If the bug could lose or damage files, please say so in the title.

Please report security problems privately, as described in
[SECURITY.md](https://github.com/mhbsiam/doftar/blob/main/.github/SECURITY.md).

## Feature ideas

I'm focusing on bugs and polish for now, so new features may have to wait.
You're still welcome to share an idea with the **Feature idea** form.

## Building from source

You need an Apple silicon Mac on macOS 27 or later with:

- Xcode Command Line Tools: `xcode-select --install`
- [Node.js](https://nodejs.org) 22.12 or later
- [Rust](https://rustup.rs) through `rustup` (`rust-toolchain.toml` sets the version)

```sh
git clone https://github.com/mhbsiam/doftar.git
cd doftar
npm ci --ignore-scripts
npm run tauri dev         # run in development mode
npm run dmg               # build the DMG
npm run dmg -- --install  # build it, then replace /Applications/Doftar.app
```

Builds are ad-hoc signed, so macOS asks you to allow them, as in the
[install steps](https://github.com/mhbsiam/doftar/blob/main/README.md#install).
After each rebuild, allow Files and Folders access again in
**System Settings → Privacy & Security**.

More detail is in
[REFERENCE.md](https://github.com/mhbsiam/doftar/blob/main/docs/REFERENCE.md#building-from-source)
and [ARCHITECTURE.md](https://github.com/mhbsiam/doftar/blob/main/docs/ARCHITECTURE.md).

## Pull requests

Small, clear fixes are welcome anytime. For anything bigger, such as a new
feature or a refactor, please open an issue first so we can talk it over.

Please keep each pull request to one change and match the surrounding code.
Doftar is offline by design, so network connections don't fit.

AI tools are fine, as long as you understand the change and have run it
yourself.

Before you open a pull request, please run the main CI checks:

```sh
npm ci --ignore-scripts
npm run build
npm test
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

By opening a pull request you agree that your contribution is licensed under
the [Apache License 2.0](https://github.com/mhbsiam/doftar/blob/main/LICENSE),
like the rest of Doftar.

I can't accept every change, even good ones, but I appreciate them all.
Thank you for helping make Doftar better!
