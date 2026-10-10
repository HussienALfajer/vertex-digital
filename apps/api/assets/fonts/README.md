# Share image fonts

The fonts the API draws the gift and receipt images with (S10 rule SH2): the store's own fallback
fonts (ADR 0012), Noto Kufi Arabic for Arabic and Montserrat for Latin letters and digits, weights
400 and 700. Both are under the SIL Open Font License (the `OFL-*.txt` files).

They come from `@fontsource/noto-kufi-arabic` 5.3.0 (`arabic` subset) and `@fontsource/montserrat`
5.3.0 (`latin` subset): the WOFF files with their tables decompressed into plain TrueType, since
the FreeType bundled with `sharp` does not read WOFF. Madani replaces Noto Kufi Arabic once its
license allows (open question Q2).
