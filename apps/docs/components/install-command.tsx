"use client";

import { Tabs } from "@bloxwap/hig/react/navigation";
import { CopyButton } from "./copy-button";

const installers = [
  { name: "bun", command: "bun add @bloxwap/smart-hyperevm" },
  { name: "npm", command: "npm install @bloxwap/smart-hyperevm" },
  { name: "pnpm", command: "pnpm add @bloxwap/smart-hyperevm" },
  { name: "yarn", command: "yarn add @bloxwap/smart-hyperevm" },
];

/** HIG Tabs own the package-manager selection (roving focus, arrow/Home/End keys, tab/panel wiring). */
export function InstallCommand() {
  return (
    <div className="install-picker" data-hig-density="compact">
      <Tabs
        label="Package manager"
        defaultValue="bun"
        items={installers.map(({ name, command }) => ({
          value: name,
          label: name,
          content: (
            <div className="install-command">
              <span aria-hidden="true">$</span>
              <code>{command}</code>
              <CopyButton text={command} label="Copy install command" className="install-copy" />
            </div>
          ),
        }))}
      />
    </div>
  );
}
