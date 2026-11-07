"""A small, safe PDB + mmCIF reader: chains and polymer residues only.

Plain text in, plain data out: nothing is evaluated, nothing recurses on the input, every loop is bounded by the
size and atom caps. Chain ids and residue numbers are the AUTHOR ones (PDB columns / mmCIF auth_asym_id, auth_seq_id)
because the viewer selects residues with those.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_BYTES = 5 * 1024 * 1024
MAX_ATOMS = 200_000
MAX_CHAINS = 2000
MAX_TITLE = 200

AA3 = {
    "ALA": "A", "CYS": "C", "ASP": "D", "GLU": "E", "PHE": "F", "GLY": "G", "HIS": "H", "ILE": "I", "LYS": "K",
    "LEU": "L", "MET": "M", "ASN": "N", "PRO": "P", "GLN": "Q", "ARG": "R", "SER": "S", "THR": "T", "VAL": "V",
    "TRP": "W", "TYR": "Y",
}
# HETATM residues that are part of a polymer chain (modified amino acids). They are reported as "X".
MODIFIED = frozenset(
    "MSE SEP TPO PTR CSO HYP KCX LLP CME MLY M3L OCS CSD CAS SMC FME PCA CSS CSX MLZ ALY SEC PYL DAL DLE DSN DVA "
    "DTH DPR DAR DAS DGL DGN DHI DLY DPN DSG DTR DTY DCY MEN AIB ABA NLE ORN TYS HIC CGU GL3 LYZ SAC SNC TPQ "
    "5HP 2MR AGM CIR NEP SVA UNK".split()
)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0e-\x1f\x7f]")
_MODEL_END = ("ENDMDL",)


class StructureError(ValueError):
    """The text is not a structure ProTop can use; the message is safe to show to the visitor."""


@dataclass
class Parsed:
    fmt: str
    title: str
    chains: list[dict] = field(default_factory=list)   # [{"name": "A", "residues": [{"num", "icode", "aa"}]}]


def looks_binary(text: str) -> bool:
    if "\x00" in text[:200_000] or "�" in text[:200_000]:
        return True
    sample = text[:200_000]
    return len(_CONTROL.findall(sample)) > max(5, len(sample) // 200)


def clean_title(raw: str) -> str:
    return " ".join("".join(c for c in raw if c.isprintable()).split())[:MAX_TITLE]


class _Collector:
    """Residues per chain, in file order, de-duplicated (alternate locations repeat a residue)."""

    def __init__(self) -> None:
        self.chains: dict[str, list[dict]] = {}
        self.seen: set[tuple[str, int, str]] = set()
        self.atoms = 0

    def atom(self) -> None:
        self.atoms += 1
        if self.atoms > MAX_ATOMS:
            raise StructureError(f"That structure has more than {MAX_ATOMS:,} atoms.")

    def residue(self, chain: str, num: int, icode: str, resname: str) -> None:
        key = (chain, num, icode)
        if key in self.seen:
            return
        self.seen.add(key)
        if chain not in self.chains:
            if len(self.chains) >= MAX_CHAINS:
                raise StructureError("That structure has too many chains.")
            self.chains[chain] = []
        self.chains[chain].append({"num": num, "icode": icode, "aa": AA3.get(resname.upper(), "X")})

    def result(self, fmt: str, title: str) -> Parsed:
        if not self.chains:
            raise StructureError("No protein or nucleic-acid chain was found in that file.")
        return Parsed(fmt, clean_title(title), [{"name": n, "residues": r} for n, r in self.chains.items()])


def _chain_name(raw: str) -> str:
    name = raw.strip() or "_"
    if len(name) > 8 or not name.isprintable() or any(c.isspace() for c in name):
        raise StructureError("The file has an unusable chain id.")
    return name


# ------------------------------------------------------------------- PDB ---


def _parse_pdb(text: str) -> Parsed:
    col = _Collector()
    title_parts: list[str] = []
    for lineno, line in enumerate(text.split("\n"), 1):
        record = line[:6]
        if record == "TITLE ":
            title_parts.append(line[10:80].strip())
        elif record == "ATOM  " or record == "HETATM":
            line = line.rstrip("\r")
            if len(line) < 54:
                raise StructureError(f"Line {lineno} is not a valid ATOM record.")
            resname = line[17:20].strip()
            if record == "HETATM" and resname.upper() not in MODIFIED:
                col.atom()
                continue
            try:
                num = int(line[22:26])
                float(line[30:38]), float(line[38:46]), float(line[46:54])
            except ValueError:
                raise StructureError(f"Line {lineno} is not a valid ATOM record.") from None
            col.atom()
            col.residue(_chain_name(line[21]), num, line[26].strip(), resname)
        elif record.startswith(_MODEL_END):
            break   # only the first model
    return col.result("pdb", " ".join(title_parts))


# ----------------------------------------------------------------- mmCIF ---


def _tokens(line: str) -> list[str]:
    """Split one mmCIF data line into values (quotes, comments). Linear, no regex backtracking."""
    out: list[str] = []
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if c in " \t\r":
            i += 1
        elif c == "#":
            break
        elif c in "'\"":
            j = i + 1
            while True:
                j = line.find(c, j)
                if j == -1:       # unterminated quote: take the rest of the line
                    j = n
                    break
                if j + 1 >= n or line[j + 1] in " \t\r":
                    break
                j += 1
            out.append(line[i + 1:j])
            i = j + 1
        else:
            j = i
            while j < n and line[j] not in " \t\r":
                j += 1
            out.append(line[i:j])
            i = j
    return out


def _parse_cif(text: str) -> Parsed:
    col = _Collector()
    title = ""
    pending_title = False
    title_lines: list[str] | None = None
    in_text = False
    names: list[str] = []
    mode = ""                     # '', 'header', 'data'
    atom_loop = False
    atoms_done = False
    idx: dict[str, int] = {}
    ncols = 0
    buf: list[str] = []
    first_model: str | None = None
    saw_data_block = False

    def setup() -> None:
        nonlocal idx, ncols, atom_loop
        atom_loop = bool(names) and names[0].startswith("_atom_site.") and not atoms_done
        if not atom_loop:
            return
        idx = {n[len("_atom_site."):]: i for i, n in enumerate(names)}
        ncols = len(names)
        if not (("auth_asym_id" in idx or "label_asym_id" in idx) and ("auth_seq_id" in idx or "label_seq_id" in idx)
                and ("auth_comp_id" in idx or "label_comp_id" in idx)):
            raise StructureError("The mmCIF atom table is missing chain, residue name or residue number columns.")

    def row(vals: list[str]) -> bool:
        """Handle one atom_site row. Returns False once the first model is over."""
        nonlocal first_model
        model = vals[idx["pdbx_PDB_model_num"]] if "pdbx_PDB_model_num" in idx else "1"
        if first_model is None:
            first_model = model
        elif model != first_model:
            return False
        col.atom()
        group = vals[idx["group_PDB"]] if "group_PDB" in idx else "ATOM"
        resname = vals[idx["auth_comp_id"] if "auth_comp_id" in idx else idx["label_comp_id"]]
        if "label_seq_id" in idx:
            polymer = vals[idx["label_seq_id"]] not in (".", "?")
        else:
            polymer = group == "ATOM" or resname.upper() in MODIFIED
        if not polymer:
            return True
        chain = _chain_name(vals[idx["auth_asym_id"] if "auth_asym_id" in idx else idx["label_asym_id"]])
        num_raw = vals[idx["auth_seq_id"]] if "auth_seq_id" in idx else vals[idx["label_seq_id"]]
        if num_raw in (".", "?") and "label_seq_id" in idx:
            num_raw = vals[idx["label_seq_id"]]
        try:
            num = int(num_raw)
        except ValueError:
            raise StructureError("The mmCIF atom table has a residue number that is not an integer.") from None
        icode = vals[idx["pdbx_PDB_ins_code"]] if "pdbx_PDB_ins_code" in idx else ""
        if icode in (".", "?"):
            icode = ""
        col.residue(chain, num, icode[:1], resname)
        return True

    for line in text.split("\n"):
        if line.startswith(";"):
            in_text = not in_text
            if in_text:
                if pending_title:
                    title_lines = [line[1:]]
                elif mode == "data" and atom_loop:
                    buf.append(".")
            elif title_lines is not None:
                title, title_lines, pending_title = " ".join(title_lines), None, False
            continue
        if in_text:
            if title_lines is not None and len(title_lines) < 20:
                title_lines.append(line)
            continue
        s = line.strip()
        if not s or s[0] == "#":
            continue
        if s.startswith("loop_"):
            if mode == "data" and atom_loop:
                atoms_done = True
            mode, names, buf = "header", [], []
            continue
        if s.startswith("data_"):
            if saw_data_block and (atoms_done or col.atoms):
                break
            saw_data_block = True
            mode = ""
            continue
        if s[0] == "_":
            if mode == "header":
                names.append(s.split(None, 1)[0].lower())
                continue
            if mode == "data" and atom_loop:
                atoms_done = True
            mode = ""
            parts = _tokens(s)
            if parts and parts[0].lower() == "_struct.title" and not title:
                if len(parts) > 1:
                    title = parts[1]
                else:
                    pending_title = True
            continue
        if pending_title:
            toks = _tokens(s)
            if toks:
                title, pending_title = toks[0], False
            continue
        if mode == "header":
            mode = "data"
            setup()
        if mode == "data" and atom_loop:
            buf.extend(_tokens(s))
            while len(buf) >= ncols:
                if not row(buf[:ncols]):
                    buf = []
                    atoms_done = True
                    mode = ""
                    break
                del buf[:ncols]
    if not col.atoms and not col.chains:
        raise StructureError("No mmCIF atom table was found in that file.")
    return col.result("cif", title)


# ----------------------------------------------------------------- entry ---


def parse_structure(text: str) -> Parsed:
    """Parse PDB or mmCIF text. Raises StructureError (safe message) for anything else."""
    if not isinstance(text, str) or not text.strip():
        raise StructureError("The file is empty.")
    if len(text) > MAX_BYTES or len(text.encode("utf-8", "replace")) > MAX_BYTES:
        raise StructureError("That file is larger than 5 MB.")
    if looks_binary(text):
        raise StructureError("That does not look like a text structure file (PDB or mmCIF).")
    if "_atom_site." in text and re.search(r"^data_", text, re.M):
        return _parse_cif(text)
    if re.search(r"^(ATOM  |HETATM)", text, re.M):
        return _parse_pdb(text)
    raise StructureError("That is not a PDB or mmCIF file (no ATOM records found).")
