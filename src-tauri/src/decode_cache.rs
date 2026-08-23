//! On-disk cache for decoded editor payloads.
//!
//! Decoding a RAW frame for the editor costs a full-resolution demosaic (AHD
//! for Bayer, bilinear for X-Trans) — seconds of CPU on a 26 MP file, and the
//! single largest part of opening a frame.  The result depends only on the
//! source file and the decode parameters, never on the edit, so it is worth
//! keeping: a cache hit turns "seconds of demosaic" into "read a file".
//!
//! The cached bytes are the exact `raw_decode` IPC payload (header + linear
//! u16 pixels + metadata trailer), so a hit is returned verbatim with no
//! re-packing.
//!
//! ## Location
//! The OS cache directory (`app_cache_dir`), not the roll's `.rolloc-meta`
//! sidecar.  Entries are large (~50 MB each), reconstructible from the RAW at
//! any time, and specific to this machine's GPU limits — exactly what a cache
//! directory is for, and exactly what should not be swept into the user's photo
//! folders or their backups.
//!
//! ## Invalidation
//! The key covers the source path, its mtime and size, and every decode
//! parameter that changes the output.  `CACHE_VERSION` covers changes to the
//! decode itself — bump it whenever the demosaic, crop or downscale changes,
//! or old entries would be served for a pipeline that no longer produces them.
//!
//! ## Eviction
//! Least-recently-used under a byte budget. Reads touch the entry's mtime, so
//! frames you keep coming back to survive and one-off browsing does not push
//! them out. A cache miss is always safe, so any IO error here degrades to
//! "decode it again" rather than failing the open.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

/// Bump when the decode output changes for identical inputs.
///
/// v2: full-resolution AHD / X-Trans demosaic with box-average downscale,
///     replacing the superpixel + tile-stride path.
const CACHE_VERSION: u32 = 2;

/// Total byte budget for the cache. Entries are ~50 MB at a 3072 px cap, so
/// this holds roughly 120 frames — several rolls' worth of recent work.
const BUDGET_BYTES: u64 = 6 * 1024 * 1024 * 1024;

/// FNV-1a over the key material.
///
/// Deliberately not `DefaultHasher`: its output is explicitly allowed to change
/// between Rust releases, which would silently orphan every existing entry.
fn fnv1a(parts: &[&str]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        // Separator so ("ab", "c") and ("a", "bc") differ.
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Directory holding cache entries, created on demand.
/// Returns `None` when the platform has no cache dir or it cannot be created.
fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .ok()?
        .join(format!("decode-v{CACHE_VERSION}"));
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Full path of the cache entry for a source file and its decode parameters.
///
/// `params` should name every input that changes the decoded bytes. Returns
/// `None` if the source file cannot be stat'd — an unreadable source has
/// nothing to cache against.
pub fn entry_path(app: &AppHandle, source: &str, params: &[&str]) -> Option<PathBuf> {
    let dir = cache_dir(app)?;
    let meta = fs::metadata(source).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();

    let mtime_s = mtime.to_string();
    let size_s = meta.len().to_string();
    let mut key: Vec<&str> = vec![source, &mtime_s, &size_s];
    key.extend_from_slice(params);

    Some(dir.join(format!("{:016x}.bin", fnv1a(&key))))
}

/// Read a cache entry, marking it as recently used.
///
/// The mtime touch is what makes eviction LRU rather than FIFO; failing to
/// touch is not an error, it only makes this entry look older than it is.
pub fn read(path: &Path) -> Option<Vec<u8>> {
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    if let Ok(file) = fs::File::options().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
    Some(bytes)
}

/// True if the entry exists and holds a complete payload.
///
/// Does not touch the mtime: probing the cache to *report* what is warm must
/// not make those entries look freshly used, or a UI that lists the whole roll
/// would defeat the LRU order it is only reading.
pub fn is_present(path: &Path) -> bool {
    matches!(fs::metadata(path), Ok(meta) if meta.is_file() && meta.len() > 0)
}

/// True if the entry exists, marking it as recently used.
///
/// For prewarming, where the caller only needs to know whether the work is
/// already done and reading the payload back would be pure waste.
pub fn touch_if_present(path: &Path) -> bool {
    if !is_present(path) {
        return false;
    }
    if let Ok(file) = fs::File::options().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
    true
}

/// Which command produced the payload.
///
/// The two decoders emit different bytes for the same source file, so their
/// keys must not collide.  Both key schemes live here so the commands and the
/// probe below cannot drift apart — a drift would silently make every probe
/// report "cold" for entries that are in fact warm.
#[derive(Clone, Copy)]
pub enum Payload {
    /// `raw_decode` — linear u16 RGBA plus the metadata trailer.
    Raw { skip_wb: bool },
    /// `decode_image_rgba` — 8-bit RGBA.
    Rgba8,
}

/// Cache entry path for a decoded payload. See `entry_path`.
pub fn payload_entry(
    app: &AppHandle,
    source: &str,
    payload: Payload,
    max_px: Option<u32>,
) -> Option<PathBuf> {
    let max_px_s = max_px.map_or_else(|| "full".to_string(), |v| v.to_string());
    match payload {
        Payload::Raw { skip_wb } => {
            let skip_wb_s = skip_wb.to_string();
            entry_path(app, source, &[&max_px_s, &skip_wb_s])
        }
        Payload::Rgba8 => entry_path(app, source, &["rgba8", &max_px_s]),
    }
}

/// One frame to probe: its absolute path and whether it decodes through the
/// RAW path (`raw_decode`) or the image path (`decode_image_rgba`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeItem {
    pub path: String,
    pub raw: bool,
}

/// Report which frames already have a warm decode, without decoding anything.
///
/// Lets the UI mark frames as full-resolution-ready on load and skip prewarming
/// them, instead of discovering it one multi-second decode at a time.  Returns
/// one bool per item, in order.
#[tauri::command]
pub fn decode_cache_probe(
    app: AppHandle,
    items: Vec<ProbeItem>,
    max_px: Option<u32>,
    skip_wb: Option<bool>,
) -> Vec<bool> {
    let skip_wb = skip_wb.unwrap_or(false);
    items
        .iter()
        .map(|item| {
            let payload = if item.raw {
                Payload::Raw { skip_wb }
            } else {
                Payload::Rgba8
            };
            payload_entry(&app, &item.path, payload, max_px)
                .is_some_and(|entry| is_present(&entry))
        })
        .collect()
}

/// Write a cache entry, then evict down to the budget.
///
/// Writes to a temporary sibling and renames, so a crash or a concurrent read
/// never sees a half-written entry (`read` would otherwise hand back a
/// truncated payload, which the frontend parses as garbage pixels).
pub fn write(path: &Path, bytes: &[u8]) {
    let tmp = path.with_extension("tmp");
    if fs::write(&tmp, bytes).is_err() {
        let _ = fs::remove_file(&tmp);
        return;
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        return;
    }
    if let Some(dir) = path.parent() {
        evict(dir);
    }
}

/// Delete least-recently-used entries until the directory is within budget.
fn evict(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
        .filter_map(|e| {
            let e = e.ok()?;
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((
                meta.modified().unwrap_or(UNIX_EPOCH),
                meta.len(),
                e.path(),
            ))
        })
        .collect();

    let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
    if total <= BUDGET_BYTES {
        return;
    }

    // Oldest first.
    files.sort_by_key(|(mtime, _, _)| *mtime);
    for (_, len, path) in files {
        if total <= BUDGET_BYTES {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}
