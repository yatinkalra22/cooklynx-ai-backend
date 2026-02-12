import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Path,
  Request,
  Route,
  Security,
  SuccessResponse,
  Tags,
} from "tsoa";
import {Request as ExpressRequest} from "express";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import {GroceryService} from "../services/grocery.service";
import {
  AddRecipeItemsRequest,
  AddManualItemRequest,
  UpdateGroceryItemRequest,
  GroceryItem,
  GroceryListResponse,
  GroupedGroceryListResponse,
} from "../types/grocery.types";
import {HTTP_STATUS} from "../config/constants";

@Route("v1/grocery")
@Tags("Grocery")
@Security("BearerAuth")
export class GroceryController extends Controller {
  /**
   * Get all items in the authenticated user's grocery list.
   * @summary Get grocery list
   */
  @Get()
  public async getGroceryList(
    @Request() request: ExpressRequest
  ): Promise<GroceryListResponse> {
    const user = request.user as AuthUser;
    const items = await GroceryService.getGroceryList(user.uid);
    return {items};
  }

  /**
   * Get grocery list grouped by recipe name.
   * @summary Get grouped grocery list
   */
  @Get("grouped")
  public async getGroupedGroceryList(
    @Request() request: ExpressRequest
  ): Promise<GroupedGroceryListResponse> {
    const user = request.user as AuthUser;
    return await GroceryService.getGroupedGroceryList(user.uid);
  }

  /**
   * Add ingredients from a recipe to the grocery list.
   * Merges quantities for identical items from the same recipe.
   * @summary Add recipe items to grocery list
   */
  @Post("recipe")
  @SuccessResponse(201, "Items added successfully")
  public async addRecipeItems(
    @Request() request: ExpressRequest,
    @Body() body: AddRecipeItemsRequest
  ): Promise<{message: string}> {
    const user = request.user as AuthUser;
    await GroceryService.addRecipeItems(user.uid, body);
    this.setStatus(HTTP_STATUS.CREATED);
    return {message: "Items added successfully"};
  }

  /**
   * Add a single manual item to the grocery list.
   * @summary Add manual item
   */
  @Post("manual")
  @SuccessResponse(201, "Item added successfully")
  public async addManualItem(
    @Request() request: ExpressRequest,
    @Body() body: AddManualItemRequest
  ): Promise<GroceryItem> {
    const user = request.user as AuthUser;
    const item = await GroceryService.addManualItem(
      user.uid,
      body.name,
      body.quantity,
      body.unit
    );
    this.setStatus(HTTP_STATUS.CREATED);
    return item;
  }

  /**
   * Update a grocery item (e.g., mark as completed, change quantity).
   * @summary Update grocery item
   * @param itemId The unique ID of the item
   */
  @Patch("{itemId}")
  public async updateGroceryItem(
    @Path() itemId: string,
    @Request() request: ExpressRequest,
    @Body() body: UpdateGroceryItemRequest
  ): Promise<{message: string}> {
    const user = request.user as AuthUser;
    await GroceryService.updateItem(user.uid, itemId, body);
    return {message: "Item updated successfully"};
  }

  /**
   * Remove an item from the grocery list.
   * @summary Remove grocery item
   * @param itemId The unique ID of the item
   */
  @Delete("{itemId}")
  @SuccessResponse(204, "Deleted")
  public async removeGroceryItem(
    @Path() itemId: string,
    @Request() request: ExpressRequest
  ): Promise<void> {
    const user = request.user as AuthUser;
    await GroceryService.removeItem(user.uid, itemId);
    this.setStatus(204);
  }
}
