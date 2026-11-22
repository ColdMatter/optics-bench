# Example setups

Open any of these with **Open…** in the app. They model the CaF/Rb tweezer experiment as described in the lab-book note *2026-11-20 Chromatic abberations in tweezer imaging* (CaFMOT-LabBook, `Daily Notes/2026/11-Nov/20/`).

| File | Shows |
| --- | --- |
| `tweezer-852nm-path.json` | The 852 nm tweezer beam: SLM with an f = 1100 mm Fresnel lens, the f = 750 mm lens, then the asphere, focusing on the atoms. |
| `rb-780nm-imaging.json` | Rb fluorescence (780 nm) from the atoms through the asphere, the 1:1 spatial-filter telescope with a 0.7 mm iris, and the f = 400 mm objective. The camera is at the 780 nm best focus. |
| `caf-606nm-camera-at-rb-focus.json` | The same system with 606 nm (CaF) added and nothing moved. The 606 nm light focuses before the iris, which clips it, and the image forms about 110 mm before the camera. |
| `caf-606nm-camera-moved.json` | 606 nm only. The iris is moved to the 606 nm focus and opened to 0.9 mm, and the camera is moved to the 606 nm best focus. |
| `caf-606nm-objective-moved.json` | 606 nm only. The camera stays at the Rb position, and the objective moves towards it until 606 nm is in focus there. The iris is moved as in the previous file. |
| `caf-606nm-no-telescope.json` | The earlier configuration, with no spatial-filter telescope. The camera is focused on Rb, and both wavelengths are shown. |

The imaging path is unfolded at the dichroic, so light runs left to right from the atoms at z = 0. The dichroic is left out, because a plate used in reflection adds no focus shift.

## Where the numbers come from

- **Asphere (Asphericon AHL15-12): a model, not the vendor prescription.** The material is S-LAH64. The EFL is 12 mm and the working distance 9.0 mm at 780 nm, which gives a centre thickness of 5.33 mm, as in the note. The curved face was computed so that collimated 780 nm light focuses perfectly, then fitted as a conic plus polynomial (k = −0.626). Its working distances match the note at all three wavelengths: 8.870 mm at 606 nm, 9.000 mm at 780 nm and 9.036 mm at 852 nm. It is marked as a `drawing` lens, so absolute focus positions in the readouts are labelled "approx.". Replace it with Asphericon's Zemax file once you have it.
- **Telescope:** two AC508-080-AB, from Thorlabs' Zemax file, with the crown side towards the collimated beam. The vertex gap of 161.9 mm makes the telescope afocal at 780 nm (the note gives 160 mm).
- **Objective:** AC508-400-B. The note doesn't give the coating suffix.
- **Distances** follow the note's measured table, taken from the asphere's curved face (its rear principal plane) to the lens vertices. L1 is 290 mm from the asphere and the objective 490 mm.
- **Tweezer path:** the SLM is 1850 mm before the 750 mm lens, not the 1950 mm measured. 1850 mm is the spacing at which the beam enters the asphere collimated, which is what the shear-plate measurement found (the note discusses the mismatch). The SLM pixel pitch of 9.2 µm is a guess; it only sets where the Fresnel phase would alias, which is far outside the beam.
- **Atoms** are at the 852 nm tweezer focus, 9.036 mm from the asphere's flat face. The source is a point emitting into NA 0.55.
- **Cameras, irises and the moved objective** are at **best** focus (minimum RMS spot), which is where focusing on the atoms by eye puts them, not at the paraxial focus.

## Compared with the note

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
