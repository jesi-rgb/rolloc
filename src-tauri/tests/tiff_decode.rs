//! Regression test: large 16-bit TIFFs must decode.
//!
//! `image::open` applies a default 512 MiB allocation cap, so a full-resolution
//! 16-bit panorama (~303 MB of RGB16 samples) fails instantly with "Memory
//! limit exceeded" — this is why 16-bit files appeared to never load.
//! `decode::decode_image` raises the cap; this test pins that behaviour and
//! demonstrates the contrast with `image::open`.
//!
//! Run with:  cargo test --test tiff_bench -- --nocapture

use std::io::Cursor;

use image::{ImageBuffer, ImageEncoder, Rgb};
use image::codecs::tiff::TiffEncoder;

// Dimensions matching the user's stitched-pano export (6146×8240 RGB16 ≈ 303 MB).
const W: u32 = 6146;
const H: u32 = 8240;

fn write_rgb16_tiff(path: &std::path::Path) {
    let mut buf = ImageBuffer::<Rgb<u16>, Vec<u16>>::new(W, H);
    for (x, y, p) in buf.enumerate_pixels_mut() {
        let r = ((x * 11 + y * 7) % 65536) as u16;
        let g = ((x * 5 + y * 13) % 65536) as u16;
        let b = ((x * 3 + y * 17) % 65536) as u16;
        *p = Rgb([r, g, b]);
    }

    let mut bytes: Vec<u8> = Vec::new();
    {
        let enc = TiffEncoder::new(Cursor::new(&mut bytes));
        let raw: &[u8] =
            unsafe { std::slice::from_raw_parts(buf.as_raw().as_ptr() as *const u8, buf.as_raw().len() * 2) };
        enc.write_image(raw, W, H, image::ExtendedColorType::Rgb16)
            .expect("encode tiff");
    }
    std::fs::write(path, &bytes).expect("write tiff");
}

#[test]
fn large_16bit_tiff_decodes() {
    let path = std::env::temp_dir().join("rolloc_decode_regression.tiff");
    write_rgb16_tiff(&path);

    // The old path (`image::open`) must fail with the default allocation cap…
    let default = image::open(&path);
    assert!(
        default.is_err(),
        "expected image::open to hit the default 512 MiB limit on a {W}x{H} RGB16 TIFF"
    );

    // …and our helper must succeed and preserve 16-bit colour.
    let img = app_lib::decode::decode_image(&path).expect("decode_image must succeed");
    assert_eq!(img.width(), W);
    assert_eq!(img.height(), H);
    assert!(
        matches!(img.color(), image::ColorType::Rgb16),
        "expected Rgb16, got {:?}",
        img.color()
    );

    let _ = std::fs::remove_file(&path);
}
