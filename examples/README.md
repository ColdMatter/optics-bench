# Example setups

Open any of these with **Open…** in the app. To print a setup's foci, waists and screen spots without opening a browser, run `npm run check-setup -- examples/<folder>/<file>.json`.

## `basics/`: one feature at a time

Work through these in order. Each one is small, shows one thing, and has a step to try. Click an element on the bench or in the table to edit it in the properties panel.

| File | Shows | Try |
| --- | --- | --- |
| `01-point-source-ideal-lens.json` | A point source imaged 2f–2f by an ideal lens (f = 100 mm). The readout puts the focus on the screen at z = 400. | Drag the lens along z and watch the image and the readout move. |
| `02-collimated-beam-ideal-lens.json` | A collimated beam focused at the focal plane. | Set the beam's angle to 2°: the focus moves to y = f·tan 2° ≈ 3.5 mm. |
| `03-gaussian-beam-and-m2.json` | Two Gaussian beams (w₀ = 1 mm) focused by an f = 200 mm lens. With M² = 2 the waist is twice as large: 99 µm against 50 µm. | Hover over the beam to read w(z). Turn off **Rays** to see only the envelopes. |
| `04-plano-convex-orientation.json` | A 20 mm beam through an LA1509 with its curved side towards the beam. Spherical aberration puts best focus 0.8 mm before paraxial focus. | Tick **Flip**: the RMS spot grows from 20 µm to 81 µm. |
| `05-chromatic-singlet.json` | 650, 780 and 852 nm through the N-BK7 singlet. The focus moves 0.9 mm across that range (Δfocus and the focal-shift plot). | Change the wavelengths, or the plot's range. |
| `06-chromatic-achromat.json` | The same beam through an AC254-100-B. The shift is about 0.06 mm, with its minimum near 780 nm. | Compare the focal-shift curve with 05. |
| `07-off-axis-4f-relay.json` | A point 2 mm off axis relayed 1:1 by two AC254-100-B (crown sides towards the collimated space between them). The image is inverted, at y = −2 mm. The readout notes that only tangential rays are traced. | Untick **Flip** on L1 and watch the image blur. |
| `08-decentred-lens.json` | An ideal lens decentred by 3 mm focuses on its own axis, at y = 3 mm. | Alt+drag the lens up and down, or give it a tilt. |
| `09-aperture-stop.json` | A 6 mm iris clips a 10° cone. Blocked rays end at the iris, and 5 of 15 reach the image. | Tick **fill first optic** on the source: the rays then just fill the iris. |
| `10-screens-through-focus.json` | Screens 1 mm either side of the AC254-100-B's best focus: about 32 µm RMS against 0.2 µm at focus. | Read the screen lines in the readouts. Move a screen. |
| `11-slm-blaze.json` | A 0.5° blaze (designed for 852 nm) steers the focus 2.62 mm at 852 nm, but only 2.40 mm at 780 nm, because diffraction is dispersive. | Change the blaze angle. |
| `12-slm-fresnel.json` | An f = 500 mm Fresnel lens on the SLM. 852 nm focuses at 500 mm, and 780 nm at 546 mm (f scales as λ₀/λ). | Add a blaze term in the properties panel. |
| `13-slm-pitch-limit.json` | An f = 50 mm Fresnel lens is too strong for 8 µm pixels. Where the phase gradient aliases (beyond about 2.7 mm), rays are blocked and the SLM is flagged with a warning. | Set the pixel pitch to 2 µm. |
| `14-overlap-warning.json` | The LA1509 overlaps the achromat. Both rows are flagged, and no rays get through. | Drag the LA1509 past z = 56 mm. |
| `15-solver-collimate.json` | A Gaussian beam through two ideal lenses (f = 50 and 150 mm) that are not yet spaced to collimate it. | In **Solver**, add a "Collimated output" target and a variable for L2, then **Run** and **Accept**. L2 moves to z ≈ 300.1, one focal length after the waist L1 forms. The panel still says "converged: no": a collimation target's cost is the beam's remaining divergence, which can't reach zero (a known issue). |
| `16-glass-extrapolated.json` | A visible-band AC508-075-A at 633, 780 and 1064 nm. Its E-BAF11 is only tabulated from 0.4 to 0.7 µm, so the readouts flag the index as extrapolated at 780 and 1064 nm. | Change 1064 nm to 650 nm: only the 780 nm warning remains. |

## `tweezer-imaging/`: chromatic aberration in tweezer imaging

These model the CaF/Rb tweezer experiment as described in the lab-book note *2026-11-20 Chromatic abberations in tweezer imaging* (CaFMOT-LabBook, `Daily Notes/2026/11-Nov/20/`).

| File | Shows |
| --- | --- |
| `tweezer-852nm-path.json` | The 852 nm tweezer beam: SLM with an f = 1100 mm Fresnel lens, the f = 750 mm lens, then the asphere, focusing on the atoms. |
| `rb-780nm-imaging.json` | Rb fluorescence (780 nm) from the atoms through the asphere, the 1:1 spatial-filter telescope with a 0.7 mm iris, and the f = 400 mm objective. The camera is at the 780 nm best focus. |
| `caf-606nm-camera-at-rb-focus.json` | The same system with 606 nm (CaF) added and nothing moved. The 606 nm light focuses before the iris, which clips it, and the image forms about 110 mm before the camera. |
| `caf-606nm-camera-moved.json` | 606 nm only. The iris is moved to the 606 nm focus and opened to 0.9 mm, and the camera is moved to the 606 nm best focus. |
| `caf-606nm-objective-moved.json` | 606 nm only. The camera stays at the Rb position, and the objective moves towards it until 606 nm is in focus there. The iris is moved as in the previous file. |
| `caf-606nm-no-telescope.json` | The earlier configuration, with no spatial-filter telescope. The camera is focused on Rb, and both wavelengths are shown. |

The imaging path is unfolded at the dichroic, so light runs left to right from the atoms at z = 0. The dichroic is left out, because a plate used in reflection adds no focus shift.

### Where the numbers come from

- **Asphere (Asphericon AHL15-12): a model, not the vendor prescription.** The material is S-LAH64. The EFL is 12 mm and the working distance 9.0 mm at 780 nm, which gives a centre thickness of 5.33 mm, as in the note. The curved face was computed so that collimated 780 nm light focuses perfectly, then fitted as a conic plus polynomial (k = −0.626). Its working distances match the note at all three wavelengths: 8.870 mm at 606 nm, 9.000 mm at 780 nm and 9.036 mm at 852 nm. It is marked as a `drawing` lens, so absolute focus positions in the readouts are labelled "approx.". Replace it with Asphericon's Zemax file once you have it.
- **Telescope:** two AC508-080-AB, from Thorlabs' Zemax file, with the crown side towards the collimated beam. The vertex gap of 161.9 mm makes the telescope afocal at 780 nm (the note gives 160 mm).
- **Objective:** AC508-400-B. The note doesn't give the coating suffix.
- **Distances** follow the note's measured table, taken from the asphere's curved face (its rear principal plane) to the lens vertices. L1 is 290 mm from the asphere and the objective 490 mm.
- **Tweezer path:** the SLM is 1850 mm before the 750 mm lens, not the 1950 mm measured. 1850 mm is the spacing at which the beam enters the asphere collimated, which is what the shear-plate measurement found (the note discusses the mismatch). The SLM pixel pitch of 9.2 µm is a guess; it only sets where the Fresnel phase would alias, which is far outside the beam.
- **Atoms** are at the 852 nm tweezer focus, 9.036 mm from the asphere's flat face. The source is a point emitting into NA 0.55.
- **Cameras, irises and the moved objective** are at **best** focus (minimum RMS spot), which is where focusing on the atoms by eye puts them, not at the paraxial focus.

### Compared with the note

The note uses thin lenses and paraxial optics. These setups use the real achromat prescriptions and trace exact rays, so the corrections come out larger. The extra comes mostly from spherical aberration of the f = 80 mm telescope lenses, whose best focus at the camera is about 11 mm before the paraxial focus (about 11 µm at the atoms).

| | Note (paraxial) | These setups, paraxial | These setups, best focus |
| --- | --- | --- | --- |
| 780 nm camera, from objective | 363 mm (principal plane) | 357 mm (back vertex) | 346 mm |
| 606 nm image, from objective | 256 mm | 242 mm | 227 mm |
| Camera move, 780 → 606 nm | 107 mm | 114 mm | 120 mm |
| Objective move, camera fixed | 125 mm | 138 mm | 152 mm |
| Iris move towards L1 | 7.9 mm | 8.7 mm | 10.3 mm |
| No telescope: 780 / 606 nm image, from objective | 360 / 198 mm | 354 / 188 mm | 353 / 157 mm |

The conclusion is unchanged: 606 nm needs the camera or the objective moved by more than 10 cm, and the iris moved or opened. The exact positions still have to be found by focusing on the molecules.
