fn main() {
    println!("cargo:rerun-if-changed=melodica");
    cc::Build::new()
        .files(["melodica/wire.c", "melodica/blowfish.c"])
        .include("melodica")
        .compile("melodica_wire");
}
