import * as dotenv from "dotenv";
dotenv.config();
import { Command } from "commander";
import { refueler, RefuelerOptions } from "./refueler";
import { makeContext } from "./context";

function actionRefueler(options: RefuelerOptions) {
  return refueler(makeContext(), options);
}

const program = new Command();

program
  .name("star-atlas-bot");
program.command("refueler")
  .option<number>("-t, --threshold <percent>", "threshold percent of resources left that will trigger a resupply", x => parseFloat(x), 10)
  .option<number>("-i, --interval <secs>", "seconds to delay between checks", x => parseFloat(x), 60 * 60)
  .action(actionRefueler);

program.parse();
