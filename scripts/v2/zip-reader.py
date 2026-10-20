"""Stream one known JSONL member from an SDE ZIP without extracting paths."""
import sys
import zipfile

archive, member = sys.argv[1:]
allowed = {"types.jsonl", "blueprints.jsonl", "_sde.jsonl", "factions.jsonl",
           "mapSolarSystems.jsonl", "mapRegions.jsonl", "mapConstellations.jsonl", "mapStargates.jsonl",
           "groups.jsonl", "typeDogma.jsonl", "dogmaAttributes.jsonl", "dogmaEffects.jsonl", "npcStations.jsonl"}
if member not in allowed:
    raise ValueError("Unsupported SDE member")
with zipfile.ZipFile(archive) as source:
    if sum(entry.file_size for entry in source.infolist()) > 2 * 1024**3:
        raise ValueError("SDE expanded size exceeds 2 GiB")
    info = source.getinfo(member)
    if info.file_size > 512 * 1024**2:
        raise ValueError("SDE member exceeds 512 MiB")
    with source.open(member) as data:
        while chunk := data.read(1024 * 1024):
            sys.stdout.buffer.write(chunk)
