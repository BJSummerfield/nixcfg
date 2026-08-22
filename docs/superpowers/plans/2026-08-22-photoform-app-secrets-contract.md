# PhotoForm App Secrets Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `BJSummerfield/Sheet-Automation-FF` deployable from the nix store — secrets from the environment, content in version control, deployment knobs overridable — and write that contract down inside the app repo so the two repos stop drifting.

**Architecture:** The config file stops being the secret store and becomes committed content. Four secrets move to environment variables and their TOML fields become a *startup error*, not an ignored key, so a secret committed by accident fails loudly instead of silently winning. Two deployment values (the Google service-account path, the PayPal mode) gain env overrides so the same package runs sandbox and live. A `--config` flag selects the file, because the systemd unit passes one.

**Tech Stack:** Rust 2021, `serde` + `toml` 0.8, `anyhow`, `axum` 0.7, sqlx/sqlite. Consumed by nixcfg's `modules/photoform/{package,nixos}.nix` (`rustPlatform.buildRustPackage`, sops-nix `sops.templates`, systemd `EnvironmentFile` + `LoadCredential`).

**Spec:** `docs/superpowers/specs/2026-08-21-photoform-service-caddy-edge-design.md` — section "App-repo prerequisites (the definition of 'photoform is ready')". This plan is the expansion of Task 1 of `docs/superpowers/plans/2026-08-21-photoform-service-caddy-edge.md`.

**Where the work happens:** Tasks 1–6 are commits in the **app repo** (`BJSummerfield/Sheet-Automation-FF`, a working checkout is at `/tmp/Sheet-Automation-FF` at rev `306b3a8`). Task 7 is a commit in **nixcfg**. This plan file lives in nixcfg because that is where the contract is specified; copy it into the app repo's `docs/superpowers/plans/` if you want it tracked next to the code it changes.

## Global Constraints

- **Env var names, verbatim:** `PHOTOFORM_PAYPAL_CLIENT_ID`, `PHOTOFORM_PAYPAL_CLIENT_SECRET`, `PHOTOFORM_SMTP_PASSWORD`, `PHOTOFORM_ADMIN_PASSWORD`, `PHOTOFORM_SHEETS_CREDENTIALS_FILE`, `PHOTOFORM_PAYPAL_MODE`.
- **The sixth name is a deliberate addition to the spec's list of five.** The spec's Task 10 promises that swapping PayPal sandbox→live is "a secrets-only change… no code", but `paypal.mode` lives in `production.toml`, so under the spec as written the flip would need an app commit, a `rev` bump and a full CI rebuild — with live credentials pointed at the sandbox API in between. `mode` is deployment configuration, not photography content, so it moves to the environment with the credentials it pairs with. If this is rejected, delete Task 4 here and fix the spec's Task 10 text instead; nothing else in the plan depends on it.
- **The dividing line:** secrets and deployment identity (credentials, PayPal mode, the service-account file path) come from the environment; everything a customer sees (event, windows, pricing, business, contract) lives in `config/production.toml` in git. `bind`, `public_url` and `database_url` stay in `production.toml` — they are fixed by the container's shape, not by the deploy.
- **A secret in the config file is an error, never a fallback.** `production.toml` ships inside a world-readable `/nix/store` path. "Optional-with-override" would let a committed secret sit there working fine.
- **No invented content.** Real event/rain dates and the four-vs-five images contradiction are Ari's answers, not the implementer's. Task 5 blocks on them.
- **Never commit a real secret**, including into a test fixture. Fixtures use obvious fakes (`cid`, `app-password`).
- `cargo test` and `cargo clippy -- -D warnings` pass before every commit. The dev shell (`nix develop` / direnv) has the toolchain.
- Record `git rev-parse HEAD` at the end — nixcfg pins it.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config.rs` | **Modify.** Secrets become `#[serde(skip)]` fields filled from the environment; a new pre-parse pass rejects secret keys found in the file; `--config` path resolution lives here so it is testable. |
| `src/main.rs` | **Modify.** Resolve the config path via the new helper instead of reading `BOOKING_CONFIG` inline. |
| `config/production.toml` | **Create.** The real, committed, secret-free deployment config. |
| `config.example.toml` | **Modify.** Stops being the secret template; documents the env contract and points at `production.toml`. |
| `contract.md` | **Modify.** Resolve the four-vs-five images contradiction. |
| `README.md` | **Modify.** New "Deployment" section — the contract, and why it exists. This is the thing that is missing today. |
| `modules/photoform/package.nix` (nixcfg) | **Modify.** `postInstall` installs `production.toml`; re-pin `rev` and both hashes. |
| `modules/photoform/nixos.nix` (nixcfg) | **Modify.** A `paypalMode` option rendered into the unit's environment. |

---

## Task 1: `--config <path>` selects the config file

The NixOS unit already ships `ExecStart = … --config …/production.toml`, and the app currently reads only `BOOKING_CONFIG`, so today that flag would be ignored and the app would look for `./config.toml` in `/var/lib/photoform` and exit. Path resolution goes in `config.rs`, not `main.rs`, so it can be tested without a process.

**Files:**
- Modify: `src/config.rs`
- Modify: `src/main.rs:15`

**Interfaces:**
- Produces: `pub type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;` and `pub fn config_path<I: IntoIterator<Item = String>>(args: I, env: EnvLookup) -> Result<PathBuf>`. Tasks 2–4 take `EnvLookup` as their injection point too.

- [ ] **Step 1: Write the failing tests**

At the end of `src/config.rs`'s `mod tests`:

```rust
    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn config_path_prefers_the_flag() {
        let p = config_path(args(&["--config", "/etc/photoform.toml"]), &no_env).unwrap();
        assert_eq!(p, PathBuf::from("/etc/photoform.toml"));
    }

    #[test]
    fn config_path_accepts_the_equals_form() {
        let p = config_path(args(&["--config=/etc/photoform.toml"]), &no_env).unwrap();
        assert_eq!(p, PathBuf::from("/etc/photoform.toml"));
    }

    #[test]
    fn config_path_falls_back_to_the_env_var_then_the_default() {
        let env = |k: &str| (k == "BOOKING_CONFIG").then(|| "dev.toml".to_string());
        assert_eq!(config_path(args(&[]), &env).unwrap(), PathBuf::from("dev.toml"));
        assert_eq!(config_path(args(&[]), &no_env).unwrap(), PathBuf::from("config.toml"));
    }

    #[test]
    fn config_path_rejects_a_flag_with_no_value() {
        let err = config_path(args(&["--config"]), &no_env).unwrap_err().to_string();
        assert!(err.contains("--config"), "got: {err}");
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test config_path`
Expected: FAIL — `cannot find function config_path in this scope`.

- [ ] **Step 3: Implement**

At the top of `src/config.rs`, extend the imports and add the helper above `impl Config`:

```rust
use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};

/// Injection point for the environment. Reading `std::env` directly would
/// make every config test depend on process-global state that parallel test
/// threads share.
pub type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// `--config <path>` wins, then `BOOKING_CONFIG`, then `config.toml` beside
/// the working directory. The systemd unit passes the flag; the dev shell
/// uses the env var.
pub fn config_path<I>(args: I, env: EnvLookup) -> Result<PathBuf>
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if let Some(path) = arg.strip_prefix("--config=") {
            return Ok(PathBuf::from(path));
        }
        if arg == "--config" {
            return args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| anyhow!("--config needs a path"));
        }
    }
    Ok(PathBuf::from(
        env("BOOKING_CONFIG").unwrap_or_else(|| "config.toml".into()),
    ))
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cargo test config_path`
Expected: 4 passed.

- [ ] **Step 5: Use it in `main.rs`**

Replace line 15 of `src/main.rs`:

```rust
    let path = std::env::var("BOOKING_CONFIG").unwrap_or_else(|_| "config.toml".into());
    let cfg = Arc::new(Config::load(&PathBuf::from(&path))?);
```

with:

```rust
    let path = nesting_box_booking::config::config_path(std::env::args().skip(1), &|k| {
        std::env::var(k).ok()
    })?;
    let cfg = Arc::new(Config::load(&path)?);
```

`use std::path::PathBuf;` is now unused in `main.rs` — delete it.

- [ ] **Step 6: Commit**

```bash
cargo test && cargo clippy -- -D warnings
git add src/config.rs src/main.rs
git commit -m "feat(config): --config flag for the config file path

The deployment unit passes a store path; BOOKING_CONFIG stays as the dev
shell's shorthand."
```

---

## Task 2: The four secrets come from the environment only

**Files:**
- Modify: `src/config.rs`

**Interfaces:**
- Consumes: `EnvLookup` (Task 1).
- Produces: `Config::from_str_with(text: &str, env: EnvLookup) -> Result<Config>` and `Config::load_with(path: &Path, env: EnvLookup) -> Result<Config>`; `Config::load(path)` keeps its signature and delegates with the real environment. `PaypalConfig.client_id`, `PaypalConfig.client_secret`, `SmtpConfig.password`, `AdminConfig.password` are `#[serde(skip)]` — present on the struct, absent from the file format.

- [ ] **Step 1: Strip the secrets out of the test fixture**

In `mod tests`, delete these lines from `SAMPLE` — the fixture must describe the new file format or the tests prove nothing:

```toml
client_id = "cid"
client_secret = "secret"
```
```toml
password = "app-password"
```
```toml
password = "change-me"
```

(`[paypal]` keeps `mode`, `[smtp]` keeps host/port/username/from/notify, `[admin]` keeps `username`.)

Then add the fixture environment above `write_config`:

```rust
    /// The four secrets as the deployment supplies them. Obvious fakes: a
    /// fixture is still a file in git.
    fn full_env(key: &str) -> Option<String> {
        match key {
            "PHOTOFORM_PAYPAL_CLIENT_ID" => Some("cid".into()),
            "PHOTOFORM_PAYPAL_CLIENT_SECRET" => Some("secret".into()),
            "PHOTOFORM_SMTP_PASSWORD" => Some("app-password".into()),
            "PHOTOFORM_ADMIN_PASSWORD" => Some("change-me".into()),
            _ => None,
        }
    }

    /// Same, minus one — for proving the app refuses to start rather than
    /// falling back to something.
    fn env_without(missing: &'static str) -> impl Fn(&str) -> Option<String> {
        move |k: &str| if k == missing { None } else { full_env(k) }
    }
```

- [ ] **Step 2: Point the existing tests at the new entry point**

Every existing test that calls `Config::load(f.path())` becomes a `Config::from_str_with(&body, &full_env)` call — no temp file needed. For example `loads_sample_config`:

```rust
    #[test]
    fn loads_sample_config() {
        let cfg = Config::from_str_with(SAMPLE, &full_env).unwrap();
        assert_eq!(cfg.pricing.price_cents, 4800);
        assert_eq!(cfg.windows.len(), 2);
        assert_eq!(cfg.windows[0].capacity, 16);
        assert_eq!(cfg.total_capacity(), 32);
        assert_eq!(cfg.window("w2").unwrap().label, "4:15-5:00pm");
        assert!(cfg.window("nope").is_none());
        assert_eq!(cfg.paypal.client_secret, "secret");
        assert_eq!(cfg.admin.password, "change-me");
    }
```

Do the same for `rejects_duplicate_window_ids`, `rejects_zero_price`, `rejects_a_public_url_without_a_scheme`, `accepts_a_public_url_with_http_scheme`, and the four `debug_output_never_contains_*` tests — they each build a `body` string and call `Config::from_str_with(&body, &full_env)`. Keep `write_config` and one test using `Config::load` so the file-reading path stays covered (Task 3 adds it).

- [ ] **Step 3: Write the failing tests for the new behaviour**

```rust
    #[test]
    fn refuses_to_start_when_a_secret_is_missing() {
        for missing in [
            "PHOTOFORM_PAYPAL_CLIENT_ID",
            "PHOTOFORM_PAYPAL_CLIENT_SECRET",
            "PHOTOFORM_SMTP_PASSWORD",
            "PHOTOFORM_ADMIN_PASSWORD",
        ] {
            let err = Config::from_str_with(SAMPLE, &env_without(missing))
                .unwrap_err()
                .to_string();
            assert!(err.contains(missing), "got: {err}");
        }
    }

    #[test]
    fn refuses_to_start_when_a_secret_is_empty() {
        let env = |k: &str| {
            if k == "PHOTOFORM_SMTP_PASSWORD" {
                Some(String::new())
            } else {
                full_env(k)
            }
        };
        assert!(Config::from_str_with(SAMPLE, &env).is_err());
    }

    #[test]
    fn rejects_a_secret_left_in_the_config_file() {
        // Not "ignored, env wins" -- production.toml ships inside a
        // world-readable /nix/store path, so a secret sitting there working
        // fine is the failure this check exists to prevent.
        for (table, line) in [
            ("[paypal]", "client_secret = \"leaked\""),
            ("[smtp]", "password = \"leaked\""),
            ("[admin]", "password = \"leaked\""),
        ] {
            let body = SAMPLE.replace(table, &format!("{table}\n{line}"));
            let err = Config::from_str_with(&body, &full_env)
                .unwrap_err()
                .to_string();
            assert!(err.contains("must not appear"), "got: {err}");
        }
    }

    #[test]
    fn still_tolerates_an_unknown_key() {
        // paypal.webhook_id is documented as harmless leftover; only the
        // named secrets are rejected.
        let body = SAMPLE.replace("[paypal]", "[paypal]\nwebhook_id = \"wh_1\"");
        assert!(Config::from_str_with(&body, &full_env).is_ok());
    }
```

- [ ] **Step 4: Run them and watch them fail**

Run: `cargo test`
Expected: FAIL — `no function or associated item named from_str_with`.

- [ ] **Step 5: Make the secret fields env-sourced**

In `src/config.rs`, add `#[serde(skip)]` to the four fields:

```rust
#[derive(Deserialize, Clone)]
pub struct PaypalConfig {
    pub mode: String,
    #[serde(skip)]
    pub client_id: String,
    #[serde(skip)]
    pub client_secret: String,
}
```

```rust
#[derive(Deserialize, Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip)]
    pub password: String,
    pub from: String,
    pub notify: String,
}
```

```rust
#[derive(Deserialize, Clone)]
pub struct AdminConfig {
    pub username: String,
    #[serde(skip)]
    pub password: String,
}
```

The manual `Debug` impls stay exactly as they are — they are what keeps these values out of the logs now that they arrive from the environment.

- [ ] **Step 6: Add the names, the loader and the rejection pass**

Above `impl Config`:

```rust
const PAYPAL_CLIENT_ID: &str = "PHOTOFORM_PAYPAL_CLIENT_ID";
const PAYPAL_CLIENT_SECRET: &str = "PHOTOFORM_PAYPAL_CLIENT_SECRET";
const SMTP_PASSWORD: &str = "PHOTOFORM_SMTP_PASSWORD";
const ADMIN_PASSWORD: &str = "PHOTOFORM_ADMIN_PASSWORD";

/// Config keys this app used to read and now refuses to. A file carrying one
/// is a startup error rather than an ignored key: `production.toml` ships in
/// a world-readable store path, so "the env value won anyway" would leave a
/// working secret sitting in git and in /nix/store.
const REJECTED_KEYS: [(&str, &str); 4] = [
    ("paypal", "client_id"),
    ("paypal", "client_secret"),
    ("smtp", "password"),
    ("admin", "password"),
];

fn required(env: EnvLookup, key: &str) -> Result<String> {
    match env(key) {
        Some(v) if !v.is_empty() => Ok(v),
        _ => bail!("{} must be set in the environment (see README, Deployment)", key),
    }
}
```

Replace `impl Config`'s `load` with:

```rust
    pub fn load(path: &Path) -> Result<Config> {
        Config::load_with(path, &|k| std::env::var(k).ok())
    }

    pub fn load_with(path: &Path, env: EnvLookup) -> Result<Config> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading config at {}", path.display()))?;
        Config::from_str_with(&text, env)
    }

    pub fn from_str_with(text: &str, env: EnvLookup) -> Result<Config> {
        let doc: toml::Value = toml::from_str(text).context("parsing config TOML")?;
        for (table, key) in REJECTED_KEYS {
            if doc.get(table).and_then(|t| t.get(key)).is_some() {
                bail!(
                    "{}.{} must not appear in the config file; it comes from the environment (see README, Deployment)",
                    table,
                    key
                );
            }
        }
        let mut cfg: Config = toml::from_str(text).context("parsing config TOML")?;
        cfg.paypal.client_id = required(env, PAYPAL_CLIENT_ID)?;
        cfg.paypal.client_secret = required(env, PAYPAL_CLIENT_SECRET)?;
        cfg.smtp.password = required(env, SMTP_PASSWORD)?;
        cfg.admin.password = required(env, ADMIN_PASSWORD)?;
        cfg.validate()?;
        Ok(cfg)
    }
```

- [ ] **Step 7: Run the whole suite**

Run: `cargo test`
Expected: all pass, including the pre-existing redaction tests.

- [ ] **Step 8: Commit**

```bash
cargo clippy -- -D warnings
git add src/config.rs
git commit -m "feat(config): the four secrets come from the environment only

The config file ships in a world-readable store path, so a secret left in
it is a startup error rather than a value the env quietly overrides."
```

---

## Task 3: `PHOTOFORM_SHEETS_CREDENTIALS_FILE` overrides the service-account path

The path is not a secret, but it is deployment-specific: on vps it is `/run/credentials/photoform.service/sheets-sa`, a systemd-managed path that has no business in committed content.

**Files:**
- Modify: `src/config.rs`

**Interfaces:**
- Produces: `sheets.service_account_json_path` becomes optional in the file (`#[serde(default)]`); resolved value is still `String` so `src/sheets.rs:139` is untouched.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn env_overrides_the_sheets_credentials_path() {
        let env = |k: &str| match k {
            "PHOTOFORM_SHEETS_CREDENTIALS_FILE" => Some("/run/credentials/x/sheets-sa".into()),
            _ => full_env(k),
        };
        let cfg = Config::from_str_with(SAMPLE, &env).unwrap();
        assert_eq!(
            cfg.sheets.service_account_json_path,
            "/run/credentials/x/sheets-sa"
        );
    }

    #[test]
    fn the_config_file_value_is_used_when_the_env_is_unset() {
        let cfg = Config::from_str_with(SAMPLE, &full_env).unwrap();
        assert_eq!(cfg.sheets.service_account_json_path, "service-account.json");
    }

    #[test]
    fn refuses_to_start_with_no_credentials_path_from_either_source() {
        let body = SAMPLE.replace("service_account_json_path = \"service-account.json\"", "");
        let err = Config::from_str_with(&body, &full_env).unwrap_err().to_string();
        assert!(err.contains("PHOTOFORM_SHEETS_CREDENTIALS_FILE"), "got: {err}");
    }
```

- [ ] **Step 2: Run and watch them fail**

Run: `cargo test sheets_credentials`
Expected: FAIL — the override is ignored, and the empty case panics on a missing field instead.

- [ ] **Step 3: Implement**

Add the constant next to the others:

```rust
const SHEETS_CREDENTIALS_FILE: &str = "PHOTOFORM_SHEETS_CREDENTIALS_FILE";
```

Make the field optional in the file format:

```rust
#[derive(Debug, Deserialize, Clone)]
pub struct SheetsConfig {
    pub spreadsheet_id: String,
    pub sheet_name: String,
    #[serde(default)]
    pub service_account_json_path: String,
}
```

In `from_str_with`, after the four `required` lines:

```rust
        if let Some(path) = env(SHEETS_CREDENTIALS_FILE) {
            cfg.sheets.service_account_json_path = path;
        }
```

And in `validate`, alongside the other checks:

```rust
        if self.sheets.service_account_json_path.is_empty() {
            bail!(
                "{} must be set, or sheets.service_account_json_path given in the config file",
                SHEETS_CREDENTIALS_FILE
            );
        }
```

- [ ] **Step 4: Run and watch them pass**

Run: `cargo test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cargo clippy -- -D warnings
git add src/config.rs
git commit -m "feat(config): env override for the sheets credentials path

The deployment's path is a systemd credentials path; committed content
cannot know it."
```

---

## Task 4: `PHOTOFORM_PAYPAL_MODE` overrides the PayPal mode

Read the second Global Constraint before starting — this task is the one deliberate addition to the spec's env list, and it exists so sandbox→live is a deploy rather than an app commit, a `rev` bump and a CI rebuild with live credentials pointed at the sandbox API in between.

**Files:**
- Modify: `src/config.rs`

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn env_overrides_the_paypal_mode() {
        let env = |k: &str| match k {
            "PHOTOFORM_PAYPAL_MODE" => Some("live".into()),
            _ => full_env(k),
        };
        let cfg = Config::from_str_with(SAMPLE, &env).unwrap();
        assert_eq!(cfg.paypal.mode, "live");
        assert_eq!(cfg.paypal_base_url(), "https://api-m.paypal.com");
    }

    #[test]
    fn a_bogus_mode_from_the_env_is_still_rejected() {
        let env = |k: &str| match k {
            "PHOTOFORM_PAYPAL_MODE" => Some("production".into()),
            _ => full_env(k),
        };
        let err = Config::from_str_with(SAMPLE, &env).unwrap_err().to_string();
        assert!(err.contains("paypal.mode"), "got: {err}");
    }
```

- [ ] **Step 2: Run and watch them fail**

Run: `cargo test paypal_mode`
Expected: FAIL — the override is ignored, so the first assertion sees `sandbox`.

- [ ] **Step 3: Implement**

```rust
const PAYPAL_MODE: &str = "PHOTOFORM_PAYPAL_MODE";
```

In `from_str_with`, before `cfg.validate()?` (so the existing sandbox/live check covers the env value too):

```rust
        if let Some(mode) = env(PAYPAL_MODE) {
            cfg.paypal.mode = mode;
        }
```

- [ ] **Step 4: Run and watch them pass**

Run: `cargo test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cargo clippy -- -D warnings
git add src/config.rs
git commit -m "feat(config): env override for the PayPal mode

Mode pairs with the credentials it selects, so both belong to the deploy:
sandbox to live is a redeploy, not a rebuild at a new rev."
```

---

## Task 5: `config/production.toml` — the real content, committed

**Files:**
- Create: `config/production.toml`
- Modify: `contract.md`

**Blocking questions.** Both are flagged in the repo's own comments and neither is the implementer's to decide. Get the answers before writing the file:

1. **The real event date and rain date.** `config.example.toml` carries "September 12, 2026" / "September 19, 2026" marked explicitly as placeholders that "must be replaced with the real event/rain dates before any parent signs the contract."
2. **Four or five images.** `contract.md` says the client receives four (4) high-resolution images; the source agreement says four on pages 1, 4 and 5 and five on page 7. It has been provisionally resolved to four pending Ari's confirmation. If the answer is five, every "four (4)" in the Services & Products *and* Products Included sections changes together — changing one and leaving the other is the failure mode the note warns about.

- [ ] **Step 1: Resolve the contract contradiction**

Apply Ari's answer to `contract.md` and delete the "OPEN CONTENT QUESTION" block from `config.example.toml`'s header (Task 6 rewrites that header anyway).

- [ ] **Step 2: Write `config/production.toml`**

Everything below is content or container shape; nothing here is a secret. `<CONFIRMED …>` markers are the Step-1 answers — the file does not get committed with a marker still in it.

```toml
# The deployed configuration: content in git, secrets in the environment.
# Installed to $out/share/photoform/production.toml and passed to the binary
# as --config. See README "Deployment" for the environment contract.
#
# A new shoot is a commit here plus a rev bump in nixcfg's
# modules/photoform/package.nix -- content changes leave cargoHash alone.

[server]
# 0.0.0.0, not 127.0.0.1: the caddy edge dials this container across
# ve-photoform. The container firewall is what limits who may connect.
bind = "0.0.0.0:8080"
public_url = "https://booking.arisummerfieldphotography.com"
# Absolute: the unit's WorkingDirectory is this same directory, but the
# bind-mounted host state dir is the thing that gets backed up.
database_url = "sqlite:///var/lib/photoform/booking.db?mode=rwc"

[business]
name = "Ari Summerfield Photography LLC"
contact_email = "AriSummerfieldPhotography@gmail.com"

[event]
name = "Nesting Box Back to School Photos 2026"
location = "The Nesting Box"
date = "<CONFIRMED EVENT DATE>"
rain_date = "<CONFIRMED RAIN DATE>"

[pricing]
price_cents = 4800
currency = "USD"
max_per_window = 4

[[windows]]
id = "w1"
label = "3:15-4:00pm"
starts_at = "15:15"
ends_at = "16:00"
capacity = 16
sawyer_url = "https://www.hisawyer.com/frenchie-farm/schedules/activity-set/1997113"

[[windows]]
id = "w2"
label = "4:15-5:00pm"
starts_at = "16:15"
ends_at = "17:00"
capacity = 16
sawyer_url = "https://www.hisawyer.com/frenchie-farm/schedules/activity-set/1997115"

# client_id and client_secret are deliberately absent -- they come from
# PHOTOFORM_PAYPAL_CLIENT_ID / _SECRET and the app rejects this file if it
# finds them. mode is the fallback for PHOTOFORM_PAYPAL_MODE.
[paypal]
mode = "sandbox"

# service_account_json_path is absent: PHOTOFORM_SHEETS_CREDENTIALS_FILE
# supplies it, pointing at systemd's LoadCredential path.
[sheets]
spreadsheet_id = "<CONFIRMED SPREADSHEET ID>"
sheet_name = "Bookings"

# password is absent -- PHOTOFORM_SMTP_PASSWORD.
[smtp]
host = "smtp.gmail.com"
port = 587
username = "AriSummerfieldPhotography@gmail.com"
from = "Ari Summerfield Photography <AriSummerfieldPhotography@gmail.com>"
notify = "AriSummerfieldPhotography@gmail.com"

# password is absent -- PHOTOFORM_ADMIN_PASSWORD.
[admin]
username = "ari"
```

`mode = "sandbox"` is the safe default: `PHOTOFORM_PAYPAL_MODE=live` in nixcfg is what makes the site take real money, so going live is an explicit act on the deployment side rather than a value that shipped in a package weeks earlier. Confirm the real `spreadsheet_id` — the example file's `sheet123` is a placeholder too.

- [ ] **Step 3: Confirm it is not gitignored**

```bash
git check-ignore -v config/production.toml; echo "exit=$?"
```

Expected: no output, `exit=1` (not ignored). `.gitignore`'s `/config.toml` is anchored to the repo root and does not match this path.

- [ ] **Step 4: Prove it loads and serves**

```bash
PHOTOFORM_PAYPAL_CLIENT_ID=x PHOTOFORM_PAYPAL_CLIENT_SECRET=x \
PHOTOFORM_SMTP_PASSWORD=x PHOTOFORM_ADMIN_PASSWORD=x \
PHOTOFORM_SHEETS_CREDENTIALS_FILE=/tmp/fake-sa.json \
cargo run -- --config config/production.toml
```

Expected: a `listening` line with `bind=0.0.0.0:8080 mode=sandbox`, plus error lines saying Sheets and email are disabled — the fake credentials are supposed to fail those two clients, and the design is that neither stops the server. `curl -sS localhost:8080 | head -20` returns the form's HTML. The sqlite path will fail unless `/var/lib/photoform` exists locally; for this check either `sudo mkdir -p /var/lib/photoform && sudo chown $USER /var/lib/photoform` or temporarily point `database_url` at `sqlite://data/booking.db?mode=rwc` and change it back before committing.

Then prove the refusal, which is the whole point of Task 2:

```bash
PHOTOFORM_PAYPAL_CLIENT_ID=x PHOTOFORM_PAYPAL_CLIENT_SECRET=x \
PHOTOFORM_ADMIN_PASSWORD=x PHOTOFORM_SHEETS_CREDENTIALS_FILE=/tmp/fake-sa.json \
cargo run -- --config config/production.toml
```

Expected: exits non-zero with `PHOTOFORM_SMTP_PASSWORD must be set in the environment`. It must not start with an empty password.

- [ ] **Step 5: Commit**

```bash
git add config/production.toml contract.md
git commit -m "feat(config): commit the deployed configuration

Content belongs in version control with the app; the deployment supplies
secrets and the two values that pick sandbox from live."
```

---

## Task 6: Write the contract down in this repo

This is the gap the review found: nothing in this repo mentions that a second consumer exists. `config.example.toml` still reads as "copy to config.toml and fill in every secret", which is now wrong in production and right only for local development.

**Files:**
- Modify: `README.md`
- Modify: `config.example.toml`

- [ ] **Step 1: Add a Deployment section to `README.md`**

Insert as a new top-level section immediately before the go-live checklist at the end of the file:

```markdown
## Deployment (NixOS, via nixcfg)

This app runs on `vps` in a systemd-nspawn container, built from a pinned
commit of this repo by
[`nixcfg`](https://github.com/BJSummerfield/nixcfg)'s
`modules/photoform/{package,nixos}.nix` and delivered as a signed closure
through a private binary cache. Section 2's `config.toml` flow is the
**development** path; deployment does not use it.

**Why the split.** A nix package is world-readable: everything in
`$out/share/photoform/production.toml` is visible to every user on the box
and to anyone who gets a copy of the closure. So the config file carries
only content, and every secret arrives in the process environment from
sops-encrypted files that live on the host and are readable by root alone.
The app enforces the split rather than trusting it — a secret key found in
the config file is a startup error, not a value the environment quietly
overrides, because "it worked anyway" is exactly how a leaked credential
survives review.

**What the deployment supplies.**

| Variable | Holds | Source on vps |
|---|---|---|
| `PHOTOFORM_PAYPAL_CLIENT_ID` | PayPal REST client id | sops → `sops.templates."photoform.env"` |
| `PHOTOFORM_PAYPAL_CLIENT_SECRET` | PayPal REST secret | same |
| `PHOTOFORM_SMTP_PASSWORD` | Gmail app password | same |
| `PHOTOFORM_ADMIN_PASSWORD` | `/admin` basic-auth password | same |
| `PHOTOFORM_SHEETS_CREDENTIALS_FILE` | *path* to the service-account JSON | systemd `LoadCredential`, `/run/credentials/photoform.service/sheets-sa` |
| `PHOTOFORM_PAYPAL_MODE` | `sandbox` or `live` | the NixOS module, plain (not a secret) |

The first four are required: the app exits at startup if any is unset or
empty. The last two override values in the config file, so local
development can ignore them.

**What this repo supplies.** `config/production.toml` — event, windows,
pricing, business details, bind address, public URL, database path. It is
committed, contains no secrets, and is installed to
`$out/share/photoform/production.toml`. The unit runs
`nesting-box-booking --config <that path>`.

**Changing the event content** (dates, windows, prices, copy) is a commit
here plus a `rev` bump in nixcfg's `modules/photoform/package.nix`; CI
rebuilds, signs and pushes the closure and the host picks it up. Content
changes do not touch `cargoHash`. At a few shoots a year that is the right
trade for keeping content with the app — it would not be at weekly cadence.

**Going live with PayPal** is a nixcfg change only: swap the sandbox
credentials in `secrets/hosts/vps.yaml` and set the module's PayPal mode to
`live`. No commit here, no rebuild.

**Rotating a secret** is `sops secrets/hosts/vps.yaml` on the nixcfg side
and a redeploy. Nothing in this repo changes.
```

- [ ] **Step 2: Rewrite `config.example.toml`'s header**

Replace the whole comment block at the top of the file (from `# Copy to config.toml` down to the end of the OPEN CONTENT QUESTION paragraph — the content question is resolved in Task 5) with:

```toml
# Local development template. Copy to config.toml and fill it in; config.toml
# is gitignored. The deployed configuration is config/production.toml, which
# is committed and holds no secrets -- see README "Deployment".
#
# The four secrets are NOT in this file and cannot be: the app rejects a
# config file that contains paypal.client_id, paypal.client_secret,
# smtp.password or admin.password. Supply them in the environment:
#
#   export PHOTOFORM_PAYPAL_CLIENT_ID=...      # sandbox app credentials
#   export PHOTOFORM_PAYPAL_CLIENT_SECRET=...
#   export PHOTOFORM_SMTP_PASSWORD=...         # Gmail app password
#   export PHOTOFORM_ADMIN_PASSWORD=...        # HTTP basic auth for /admin
#
# Optional, both defaulting to the values in this file:
#   PHOTOFORM_SHEETS_CREDENTIALS_FILE   path to the service-account JSON
#   PHOTOFORM_PAYPAL_MODE               "sandbox" or "live"
#
# The spreadsheet must be shared with the service account's client_email as
# an Editor, or Sheets sync fails (the server still takes bookings and
# queues them).
```

Then delete the `client_id`, `client_secret`, `smtp.password` and
`admin.password` lines from the file body — leaving them would make the
example file itself fail to load.

- [ ] **Step 3: Check the README's other claims still hold**

Section 2 says `config.toml` "holds every secret this server uses… and must never be committed". Reword to point at the env vars, or the README now contradicts itself two sections apart.

- [ ] **Step 4: Prove the example file is loadable**

```bash
cp config.example.toml /tmp/example-check.toml
PHOTOFORM_PAYPAL_CLIENT_ID=x PHOTOFORM_PAYPAL_CLIENT_SECRET=x \
PHOTOFORM_SMTP_PASSWORD=x PHOTOFORM_ADMIN_PASSWORD=x \
cargo run -- --config /tmp/example-check.toml
```

Expected: it starts (then fails on Sheets/SMTP, which is fine). If it exits with "must not appear in the config file", a secret line survived Step 2.

- [ ] **Step 5: Commit and record the rev**

```bash
git add README.md config.example.toml
git commit -m "docs: the deployment contract, and why the secrets left the config file"
git push
git rev-parse HEAD
```

Save that rev — Task 7 pins it.

---

## Task 7: Re-pin and wire it up in nixcfg

**Files:**
- Modify: `modules/photoform/package.nix` (nixcfg)
- Modify: `modules/photoform/nixos.nix` (nixcfg)

**Interfaces:**
- Consumes: the app rev from Task 6 Step 5.
- Produces: a `photoform` package whose `$out/share/photoform/production.toml` exists, and a module that sets `PHOTOFORM_PAYPAL_MODE`.

**Ordering:** this task supersedes the hash discovery in binary-cache plan Task 8 — the `feat/photoform-package` branch already did that dance at rev `306b3a8`, which predates every commit above, so both hashes change. Start from that branch (it also has `passthru.cache = true` and the `photoform` entry in `flake.nix`'s `packages`, both of which are still needed) and re-run its hash discovery at the new rev.

- [ ] **Step 1: Install `production.toml` from the package**

In `modules/photoform/package.nix`, after `cargoHash`:

```nix
  # cargo installs binaries only. The module passes --config at this path,
  # so the content has to be part of the package, not the module.
  postInstall = ''
    install -Dm444 config/production.toml $out/share/photoform/production.toml
  '';
```

- [ ] **Step 2: Re-pin the rev and rediscover both hashes**

Set `rev` to Task 6's value, put `lib.fakeSha256` back in `sha256`, push, and read the real source hash out of the CI log; then substitute it, push again, and read `cargoHash`. This is binary-cache plan Task 8 Steps 2–5 verbatim — the credentials and failure table are there. Two hashes, two CI runs, source first.

- [ ] **Step 3: Add the PayPal mode option**

In `modules/photoform/nixos.nix`, add to `options.mine.system.photoform`:

```nix
    paypalMode = lib.mkOption {
      type = lib.types.enum [
        "sandbox"
        "live"
      ];
      default = "sandbox";
      description = ''
        Which PayPal API the app talks to. Not a secret, but it pairs with
        the credentials in sopsFile: both must move together, so live money
        is one deploy rather than a rebuild at a new app rev.
      '';
    };
```

and in the container's service config, beside `EnvironmentFile`:

```nix
              Environment = [ "PHOTOFORM_PAYPAL_MODE=${cfg.paypalMode}" ];
```

- [ ] **Step 4: Verify the package carries the config**

```bash
nix build --no-link --print-out-paths .#photoform
ls -l "$(nix eval --raw .#photoform)/share/photoform/production.toml"
```

Expected: the file exists, mode `444`. Then prove it holds no secrets:

```bash
grep -nE 'client_secret|client_id|password' "$(nix eval --raw .#photoform)/share/photoform/production.toml"
```

Expected: no output. Any hit means Task 5 shipped a secret into the store.

- [ ] **Step 5: Confirm the store path is what the container will run**

```bash
nix eval --raw .#packages.x86_64-linux.photoform.drvPath
nix eval --impure --raw --expr 'let f = builtins.getFlake (toString ./.); in (f.nixosConfigurations.vps.extendModules { modules = [ { mine.system.photoform = { enable = true; sopsFile = ./secrets/hosts/vps.yaml; }; } ]; }).config.system.build.toplevel.drvPath'
```

Expected: the first command's path is the one CI builds and pushes; the second evaluates without error, proving the module still composes with the new option. A mismatch in the first would mean the host's `pkgs` diverges from `nixpkgs.legacyPackages` and the cache push would never be used.

- [ ] **Step 6: Commit**

```bash
nix fmt
git add modules/photoform/package.nix modules/photoform/nixos.nix
git commit -m "feat(photoform): pin the secrets-contract rev, install its config

The app now takes --config and reads its four secrets from the
environment, so the package carries production.toml and the module carries
the PayPal mode."
```

- [ ] **Step 7: Tick Task 1 of the edge plan**

Every box in `docs/superpowers/plans/2026-08-21-photoform-service-caddy-edge.md` Task 1 is now satisfied. Tick them, then continue there at Task 2 (binary-cache Tasks 8–9) with this rev.

---

## Verification

- `cargo test` passes, including: a missing secret refuses startup, an empty secret refuses startup, a secret in the file is rejected, an unknown key is still tolerated, both env overrides win, and the four pre-existing redaction tests still hold with env-sourced values.
- `cargo run -- --config config/production.toml` with the four vars set starts and serves the form; with one unset it exits with that variable's name.
- `grep` finds no secret in `$out/share/photoform/production.toml`.
- `git check-ignore config/production.toml` reports not-ignored.
- The README's Deployment section and `config.example.toml`'s header agree with each other and with `modules/photoform/nixos.nix`.

## Success criteria

- The deployed package contains zero secrets and the app will not start with one in its config file.
- A new shoot is one commit here plus a `rev` bump in nixcfg.
- Sandbox→live is a nixcfg-only change, as the edge plan's Task 10 already promises.
- Someone opening this repo for the first time can find out, from this repo, what the deployment expects of it and why.
