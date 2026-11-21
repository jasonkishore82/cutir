import { ACCEPT, useMedia } from "../store/media";
import { useLibrary } from "../store/library";

/** Pick files for the media pool (any kind it accepts). */
export function importMediaFiles() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ACCEPT;
  input.onchange = () => input.files?.length && void useMedia.getState().addFiles(Array.from(input.files));
  input.click();
}

/** Open a project file saved from Cutir as a new project. */
export function importProjectFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      await useLibrary.getState().importProject(f.name.replace(/\.json$/i, ""), JSON.parse(await f.text()));
    } catch {
      window.alert("Could not read that project file.");
    }
  };
  input.click();
}
