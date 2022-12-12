# Star Atlas Bot
Various bots for interacting with [Star Atlas](https://staratlas.com/). Currently only a [SCORE](https://play.staratlas.com/fleet) re-supply bot, but could be more in the future :)


## What Does It Do?
 - Monitor all your staked SCORE fleets, re-supplying them with R4 as needed
 - Purchase needed R4 from the Marketplace if your account does not have enough to properly re-supply
 - Claim any pending ATLAS rewards if your account does not have enough to purchase the R4

## How to Use It
First, rename `.env.sample` to `.env` and fill in the `SECRET_KEY` and `RPC_URL` parameters. `SECRET_KEY` should be the Base58 encoded private key of your account (this is what Phantom gives you as your secret key). `RPC_URL` is a Solana RPC URL.

Then:

```sh
yarn
yarn run score-refueler
```

By default, the bot will re-check your fleet every hour (configurarable by `--interval <secs>`) and will initiate a re-supply if any R4 drops below 10% (configurable by `--threshold <percent>`).

### Sample Output
```
=============  11/29/2022, 10:21:00 PM  ==============
Fleets:  3
ATLAS:  1967.64072252 Fuel:  0 Food:  0 Arms:  0 Toolkits:  9325
Fuel needed:  147471  Food needed:  49871 Arms needed:  160178 Toolkits needed:  150853
Purchasing  147472 FUEL  for  212.85518592  ATLAS
Purchasing  49872 FOOD  for  30.6413568  ATLAS
Purchasing  160179 AMMO  for  344.44731981  ATLAS
Purchasing  150854 TOOL  for  262.6066432  ATLAS
Topping off  Pearce R6  for  Fuel:  511  Food:  464  Arms:  418  Toolkits:  604
Topping off  Ogrika Sunpaa  for  Fuel:  146859  Food:  49325  Arms:  159625  Toolkits:  10
Topping off  Pearce X5  for  Fuel:  97  Food:  78  Arms:  130  Toolkits:  136
```

----
Made by [ghenjei](https://twitter.com/0xghenjei) of [Aephia Industries](https://aephia.com/)
