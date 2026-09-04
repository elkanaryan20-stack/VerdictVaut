import { Controller, Get } from "@nestjs/common";
import { AssetsNetworksService } from "./assets-networks.service";

@Controller("wallet")
export class AssetsNetworksController {
  constructor(private readonly assetsNetworksService: AssetsNetworksService) {}

  @Get("assets")
  listAssets() {
    return this.assetsNetworksService.listAssets();
  }

  @Get("networks")
  listNetworks() {
    return this.assetsNetworksService.listNetworks();
  }

  @Get("asset-networks")
  listActiveAssetNetworks() {
    return this.assetsNetworksService.listActiveAssetNetworks();
  }
}
