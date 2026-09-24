import { createContext, useContext } from "solid-js";
import type { FileProject, FileReference } from "./projectFiles";

export const FilePaneContext = createContext<{
  open: (project: FileProject, file?: FileReference) => void;
}>();

export const useFilePane = () => useContext(FilePaneContext);
