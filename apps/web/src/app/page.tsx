import { TaskBoard } from "../features/tasks/task-board";
import { SettingsConsole } from "../features/settings/settings-console";

export default function Home() {
  return (
    <>
      <TaskBoard />
      <SettingsConsole />
    </>
  );
}
