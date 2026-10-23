export type FolderColorId =
  | "yellow"
  | "grey"
  | "blue"
  | "teal"
  | "green"
  | "purple"
  | "rose"
  | "clay";

// [back top, back bottom, front top, front bottom]
export const FOLDER_COLORS: {
  id: FolderColorId;
  label: string;
  stops: [string, string, string, string];
}[] = [
  { id: "yellow", label: "Yellow", stops: ["#f3b73d", "#d9962a", "#ffe08a", "#f7c04a"] },
  { id: "grey", label: "Grey", stops: ["#a3a9b3", "#7d848f", "#d6dae0", "#b4bac3"] },
  { id: "blue", label: "Slate blue", stops: ["#8aa7cc", "#6585ae", "#c4d4e9", "#9db8d8"] },
  { id: "teal", label: "Sage teal", stops: ["#7fb3ae", "#5b918c", "#bddcd8", "#93c1bc"] },
  { id: "green", label: "Moss green", stops: ["#93b490", "#6f9470", "#c8dcc5", "#a3c3a1"] },
  { id: "purple", label: "Dusty purple", stops: ["#a399c6", "#7e74a6", "#d0cae6", "#b2a9d3"] },
  { id: "rose", label: "Dusty rose", stops: ["#cf9aa6", "#b07682", "#ebcdd3", "#d9a9b3"] },
  { id: "clay", label: "Clay", stops: ["#d3a07f", "#b57d5a", "#ecd0b9", "#dcb094"] },
];

export function folderStops(id: FolderColorId) {
  return (FOLDER_COLORS.find((c) => c.id === id) ?? FOLDER_COLORS[0]).stops;
}
