import { Metaplex, Sft } from "@metaplex-foundation/js";
import { PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  createHarvestInstruction,
  createRearmInstruction, createRefeedInstruction, createRefuelInstruction, createRepairInstruction,
  getAllFleetsForUserPublicKey, getAssociatedTokenAddress, getScoreVarsInfo, getScoreVarsShipInfo,
  GmClientService, OrderSide, ScoreVarsShipInfo, ShipStakingInfo
} from "@staratlas/factory";
import { ATLAS_MINT, MARKETPLACE_PROGRAM, SCORE_PROGRAM } from "./constants";
import { Context } from "./context";

export interface RefuelerOptions {
  threshold: number,
  interval: number
}

interface ShipInfo {
  mint: PublicKey,
  scoreVars: ScoreVarsShipInfo,
  metadata: Sft
}

class ConsumableData {
  private burnRates: number[];
  private totalNeeded_: number;
  readonly neededByFleet: Map<number, number>;

  constructor() {
    this.burnRates = [];
    this.neededByFleet = new Map<number, number>();
    this.totalNeeded_ = 0;
  }

  get burnRate() {
    return this.burnRates.reduce((prev, curr) => prev + curr, 0);
  }

  get totalNeeded() {
    return this.totalNeeded_;
  }

  update(
    currentCapacityTimestampDiff: number,
    millisecondsToBurnOne: number,
    numShips: number,
    currentCapacity: number,
    maxReserve: number,
    fleetIndex: number) {
    const burnRate = millisecondsToBurnOne / 1000 * numShips;
    const reserve = currentCapacity / burnRate;
    const left = reserve - currentCapacityTimestampDiff / burnRate;
    const percent = left / maxReserve;
    this.burnRates.push(burnRate);
    const needed = Math.max(maxReserve - left, 0);
    this.neededByFleet.set(fleetIndex, needed);
    this.totalNeeded_ = this.totalNeeded_ + needed;
    return percent;
  }
}

class ResourceCounter {
  private context: Context;
  private metaplex: Metaplex;
  readonly shipInfos: Map<PublicKey, ShipInfo>;
  private fleetLowestPercent: Map<number, number>;
  private now: number;
  readonly toolkits: ConsumableData;
  readonly fuel: ConsumableData;
  readonly food: ConsumableData;
  readonly arms: ConsumableData;

  constructor(context: Context, metaplex: Metaplex) {
    this.context = context;
    this.metaplex = metaplex;
    this.shipInfos = new Map<PublicKey, ShipInfo>();
    this.fleetLowestPercent = new Map<number, number>();
    this.now = new Date().getTime() / 1000;
    this.toolkits = new ConsumableData();
    this.fuel = new ConsumableData();
    this.food = new ConsumableData();
    this.arms = new ConsumableData();
  }

  getShipName(shipMint: PublicKey) {
    return this.shipInfos.get(shipMint)?.metadata.name ?? "UNKNOWN";
  }

  updateFleetLowestPercent(fleetIndex: number, percent: number) {
    const currentPercent = this.fleetLowestPercent.get(fleetIndex);
    if (currentPercent === undefined || percent < currentPercent) {
      this.fleetLowestPercent.set(fleetIndex, percent);
    }
  }

  async updateFromFleet(fleet: ShipStakingInfo, fleetIndex: number) {
    if (this.shipInfos.get(fleet.shipMint) === undefined) {
      this.shipInfos.set(
        fleet.shipMint, {
        mint: fleet.shipMint,
        scoreVars: await getScoreVarsShipInfo(this.context.connection, SCORE_PROGRAM, fleet.shipMint),
        metadata: await this.metaplex.nfts().findByMint({ mintAddress: fleet.shipMint }) as Sft
      });
    }
    const shipInfo = this.shipInfos.get(fleet.shipMint) as ShipInfo;
    const currentCapacityTimestampDiff = (this.now - fleet.currentCapacityTimestamp.toNumber());
    const numShips = fleet.shipQuantityInEscrow.toNumber();

    this.updateFleetLowestPercent(fleetIndex, this.toolkits.update(
      currentCapacityTimestampDiff,
      shipInfo.scoreVars.millisecondsToBurnOneToolkit,
      numShips,
      fleet.healthCurrentCapacity.toNumber(),
      shipInfo.scoreVars.toolkitMaxReserve,
      fleetIndex
    ));

    this.updateFleetLowestPercent(fleetIndex, this.fuel.update(
      currentCapacityTimestampDiff,
      shipInfo.scoreVars.millisecondsToBurnOneFuel,
      numShips,
      fleet.fuelCurrentCapacity.toNumber(),
      shipInfo.scoreVars.fuelMaxReserve,
      fleetIndex
    ));

    this.updateFleetLowestPercent(fleetIndex, this.food.update(
      currentCapacityTimestampDiff,
      shipInfo.scoreVars.millisecondsToBurnOneFood,
      numShips,
      fleet.foodCurrentCapacity.toNumber(),
      shipInfo.scoreVars.foodMaxReserve,
      fleetIndex
    ));

    this.updateFleetLowestPercent(fleetIndex, this.arms.update(
      currentCapacityTimestampDiff,
      shipInfo.scoreVars.millisecondsToBurnOneArms,
      numShips,
      fleet.armsCurrentCapacity.toNumber(),
      shipInfo.scoreVars.armsMaxReserve,
      fleetIndex
    ));
  }

  fleetNeedsRefuel(fleetIndex: number, threshold: number) {
    const lowest = this.fleetLowestPercent.get(fleetIndex);
    return lowest !== undefined && lowest < threshold;
  }
}

async function quoteFromMarketplace(
  context: Context,
  gm: GmClientService,
  asset: Sft,
  amount: number
) {
  const openOrders =
    (await gm.getOpenOrdersForAsset(context.connection, asset.address, MARKETPLACE_PROGRAM))
      .filter(order =>
        order.orderType === OrderSide.Sell &&
        new PublicKey(order.currencyMint).equals(ATLAS_MINT) && order.orderQtyRemaining >= amount)
      .sort((a, b) => a.uiPrice - b.uiPrice);

  if (openOrders.length === 0)
    return undefined;
  const order = openOrders[0];
  const totalPrice = order.priceForQuantity(amount);

  return { order, totalPrice };
}

async function getAtlasTokensBalance(context: Context, atlasAccount: PublicKey) {
  return (await context.connection.getTokenAccountBalance(atlasAccount)).value.uiAmount ?? 0;
}

async function buyFromMarketplace(
  context: Context,
  gm: GmClientService,
  asset: Sft,
  amount: number,
  atlasAccount: PublicKey
) {
  const quote = await quoteFromMarketplace(context, gm, asset, amount);
  if (quote === undefined)
    return 0;

  const { order, totalPrice } = quote;
  console.log("Purchasing ", amount, asset.symbol, " for ", totalPrice, " ATLAS");

  const atlasBalance = await getAtlasTokensBalance(context, atlasAccount);
  if (atlasBalance < totalPrice) {
    throw new Error(`Insufficent ATLAS, needed ${totalPrice} but only have ${atlasBalance}`);
  }

  const tx =
    await gm.getCreateExchangeTransaction(context.connection, order, context.keypair.publicKey, amount, MARKETPLACE_PROGRAM);
  const hash = await context.connection.sendTransaction(tx.transaction, [context.keypair]);
  await context.connection.confirmTransaction(hash);

  console.log(hash);
  return amount;
}

async function topOffInstruction(
  context: Context,
  asset: Sft,
  amount: number,
  account: PublicKey,
  shipMint: PublicKey,
  func: typeof createRefuelInstruction
) {
  return func(
    context.connection,
    context.keypair.publicKey,
    context.keypair.publicKey,
    amount,
    shipMint,
    asset.mint.address,
    account,
    SCORE_PROGRAM
  );
}

async function runRefueler(context: Context, options: RefuelerOptions) {
  console.log("============== ", new Date().toLocaleString(), " ==============");

  const fleets = await getAllFleetsForUserPublicKey(
    context.connection,
    context.keypair.publicKey,
    SCORE_PROGRAM
  );
  console.log("Fleets: ", fleets.length);

  const scoreVars = await getScoreVarsInfo(context.connection, SCORE_PROGRAM);

  const metaplex = new Metaplex(context.connection);
  const [atlasMeta, fuelMeta, foodMeta, armsMeta, toolkitMeta] = await Promise.all([
    metaplex.nfts().findByMint({ mintAddress: ATLAS_MINT }),
    metaplex.nfts().findByMint({ mintAddress: scoreVars.fuelMint }),
    metaplex.nfts().findByMint({ mintAddress: scoreVars.foodMint }),
    metaplex.nfts().findByMint({ mintAddress: scoreVars.armsMint }),
    metaplex.nfts().findByMint({ mintAddress: scoreVars.toolkitMint })
  ]) as Sft[];

  const [atlasAccount, fuelAccount, foodAccount, armsAccount, toolkitAccount] = await Promise.all([
    getAssociatedTokenAddress(context.keypair.publicKey, ATLAS_MINT),
    getAssociatedTokenAddress(context.keypair.publicKey, scoreVars.fuelMint),
    getAssociatedTokenAddress(context.keypair.publicKey, scoreVars.foodMint),
    getAssociatedTokenAddress(context.keypair.publicKey, scoreVars.armsMint),
    getAssociatedTokenAddress(context.keypair.publicKey, scoreVars.toolkitMint)
  ]);

  const [atlas, fuel, food, arms, toolkits] = (await Promise.all([
    context.connection.getTokenAccountBalance(atlasAccount),
    context.connection.getTokenAccountBalance(fuelAccount),
    context.connection.getTokenAccountBalance(foodAccount),
    context.connection.getTokenAccountBalance(armsAccount),
    context.connection.getTokenAccountBalance(toolkitAccount),
  ])).map(x => x.value);

  console.log("ATLAS: ", atlas.uiAmount, "Fuel: ", fuel.uiAmount, "Food: ", food.uiAmount, "Arms: ", arms.uiAmount, "Toolkits: ", toolkits.uiAmount);

  const counter = new ResourceCounter(context, metaplex);
  await Promise.all(fleets.map((fleet, index) => counter.updateFromFleet(fleet, index)));

  let fuelNeeded = Math.max(Math.floor(counter.fuel.totalNeeded - (fuel.uiAmount ?? 0)), 0);
  let foodNeeded = Math.max(Math.floor(counter.food.totalNeeded - (food.uiAmount ?? 0)), 0);
  let armsNeeded = Math.max(Math.floor(counter.arms.totalNeeded - (arms.uiAmount ?? 0)), 0);
  let toolkitsNeeded = Math.max(Math.floor(counter.arms.totalNeeded - (toolkits.uiAmount ?? 0)), 0);

  console.log("Fuel needed: ", fuelNeeded, " Food needed: ", foodNeeded, "Arms needed: ", armsNeeded, "Toolkits needed: ", toolkitsNeeded);

  const fleetNeedsRefuel =
    [...Array(fleets.length).keys()]
      .map(index => counter.fleetNeedsRefuel(index, options.threshold / 100));

  const anyFleetNeedsRefuel = fleetNeedsRefuel.reduce((prev, curr) => prev || curr, false);
  if (!anyFleetNeedsRefuel) {
    console.log("No refuel needed");
    return;
  }

  const gm = new GmClientService();

  const atlasNeeded = (await Promise.all([
    quoteFromMarketplace(context, gm, fuelMeta, fuelNeeded + 1),
    quoteFromMarketplace(context, gm, foodMeta, foodNeeded + 1),
    quoteFromMarketplace(context, gm, armsMeta, armsNeeded + 1),
    quoteFromMarketplace(context, gm, toolkitMeta, toolkitsNeeded + 1),
  ])).reduce((acc, quote) => acc + (quote !== undefined ? quote.totalPrice : 0), 0);

  for (let i = 0; i < fleets.length; ++i) {
    const atlasBalance = await getAtlasTokensBalance(context, atlasAccount);
    if (atlasBalance < atlasNeeded) {
      console.log("Harvesting ATLAS from ", counter.getShipName(fleets[i].shipMint));
      const factoryReturn = await createHarvestInstruction(context.connection, context.keypair.publicKey, ATLAS_MINT, fleets[i].shipMint, SCORE_PROGRAM);
      // assumes atlas account already exists
      const instructions = [factoryReturn.instructions[factoryReturn.instructions.length - 1]];
      const latestBlockhash = await context.connection.getLatestBlockhash('finalized');
      const message = new TransactionMessage({
        payerKey: context.keypair.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions
      }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      transaction.sign([context.keypair]);
      const hash = await context.connection.sendTransaction(transaction);
      await context.connection.confirmTransaction({
        signature: hash,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      });
      console.log(hash);
    } else {
      break;
    }
  }
  const atlasBalance = await getAtlasTokensBalance(context, atlasAccount);
  if (atlasBalance < atlasNeeded) {
    throw new Error(`Insufficent ATLAS, needed ${atlasNeeded} but only have ${atlasBalance}`);
  }

  if (fuelNeeded > 0)
    fuelNeeded = fuelNeeded - await buyFromMarketplace(context, gm, fuelMeta, fuelNeeded + 1, atlasAccount);
  if (foodNeeded > 0)
    foodNeeded = foodNeeded - await buyFromMarketplace(context, gm, foodMeta, foodNeeded + 1, atlasAccount);
  if (armsNeeded > 0)
    armsNeeded = armsNeeded - await buyFromMarketplace(context, gm, armsMeta, armsNeeded + 1, atlasAccount);
  if (toolkitsNeeded > 0)
    toolkitsNeeded = toolkitsNeeded - await buyFromMarketplace(context, gm, toolkitMeta, toolkitsNeeded + 1, atlasAccount);

  for (let i = 0; i < fleets.length; ++i) {
    const instructions: TransactionInstruction[] = [];
    const fleetFuelNeeded = Math.max(Math.floor(counter.fuel.neededByFleet.get(i) ?? 0) - 1, 0);
    if (fleetFuelNeeded > 0)
      instructions.push(await topOffInstruction(context, fuelMeta, fleetFuelNeeded, fuelAccount, fleets[i].shipMint, createRefuelInstruction));
    const fleetFoodNeeded = Math.max(Math.floor(counter.food.neededByFleet.get(i) ?? 0) - 1, 0);
    if (fleetFoodNeeded > 0)
      instructions.push(await topOffInstruction(context, foodMeta, fleetFoodNeeded, foodAccount, fleets[i].shipMint, createRefeedInstruction));
    const fleetArmsNeeded = Math.max(Math.floor(counter.arms.neededByFleet.get(i) ?? 0) - 1, 0);
    if (fleetArmsNeeded > 0)
      instructions.push(await topOffInstruction(context, armsMeta, fleetArmsNeeded, armsAccount, fleets[i].shipMint, createRearmInstruction));
    const fleetToolkitsNeeded = Math.max(Math.floor(counter.toolkits.neededByFleet.get(i) ?? 0) - 1, 0);
    if (fleetToolkitsNeeded > 0)
      instructions.push(await topOffInstruction(context, toolkitMeta, fleetToolkitsNeeded, toolkitAccount, fleets[i].shipMint, createRepairInstruction));
    if (instructions.length > 0) {
      console.log("Topping off ", counter.getShipName(fleets[i].shipMint), " for ",
        "Fuel: ", fleetFuelNeeded, " Food: ", fleetFoodNeeded, " Arms: ", fleetArmsNeeded, " Toolkits: ", fleetToolkitsNeeded);
      const latestBlockhash = await context.connection.getLatestBlockhash('finalized');
      const message = new TransactionMessage({
        payerKey: context.keypair.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions
      }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      transaction.sign([context.keypair]);
      const hash = await context.connection.sendTransaction(transaction);
      await context.connection.confirmTransaction({
        signature: hash,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      }, 'finalized');
      console.log(hash);
    }
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function refueler(context: Context, options: RefuelerOptions) {
  while (true) {
    try {
      await runRefueler(context, options);
    }
    catch (err: any) {
      console.log(err);
    }
    await sleep(options.interval * 1000);
  }
}
