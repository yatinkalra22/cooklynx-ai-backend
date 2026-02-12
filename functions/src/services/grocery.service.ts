import {database} from "../config/firebase.config";
import {
  GroceryItem,
  AddRecipeItemsRequest,
  UpdateGroceryItemRequest,
  GroupedGroceryListResponse,
  RecipeGroup,
} from "../types/grocery.types";
import * as logger from "firebase-functions/logger";
import {randomUUID} from "crypto";

export class GroceryService {
  private static getRef(userId: string) {
    return database.ref(`groceryLists/${userId}/items`);
  }

  /**
   * Generates a key to determine if two ingredients are the "same" for merging.
   * Based on name, unit, and recipe (to support grouping).
   */
  private static generateMergeKey(item: {
    name: string;
    unit: string;
    recipeId?: string | null;
  }): string {
    const name = item.name.trim().toLowerCase();
    const unit = item.unit.trim().toLowerCase();
    const recipeId = item.recipeId || "";
    return `${name}|${unit}|${recipeId}`;
  }

  /**
   * Get all items in the user's grocery list.
   */
  static async getGroceryList(userId: string): Promise<GroceryItem[]> {
    try {
      const snapshot = await this.getRef(userId).once("value");
      if (!snapshot.exists()) return [];

      const itemsMap = snapshot.val() as {[key: string]: GroceryItem};
      return Object.values(itemsMap).sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    } catch (error) {
      logger.error("Error fetching grocery list:", error);
      throw error;
    }
  }

  /**
   * Get items grouped by recipe.
   */
  static async getGroupedGroceryList(
    userId: string
  ): Promise<GroupedGroceryListResponse> {
    try {
      const items = await this.getGroceryList(userId);

      const groupsMap: {[key: string]: RecipeGroup} = {};
      const unassignedItems: GroceryItem[] = [];
      let unassignedCompleted = 0;

      items.forEach((item) => {
        if (item.recipeName || item.recipeId) {
          // Group by recipeId if available, otherwise recipeName
          const groupKey = item.recipeId || item.recipeName || "unknown";

          if (!groupsMap[groupKey]) {
            groupsMap[groupKey] = {
              recipeId: item.recipeId ?? undefined,
              recipeName: item.recipeName || "Unknown Recipe",
              recipeThumbnail: item.recipeThumbnail ?? undefined,
              items: [],
              totalItems: 0,
              completedItems: 0,
            };
          }

          const group = groupsMap[groupKey];
          group.items.push(item);
          group.totalItems++;
          if (item.completed) {
            group.completedItems++;
          }
        } else {
          unassignedItems.push(item);
          if (item.completed) {
            unassignedCompleted++;
          }
        }
      });

      return {
        groups: Object.values(groupsMap).sort((a, b) =>
          a.recipeName.localeCompare(b.recipeName)
        ),
        unassigned: {
          items: unassignedItems,
          totalItems: unassignedItems.length,
          completedItems: unassignedCompleted,
        },
      };
    } catch (error) {
      logger.error("Error fetching grouped grocery list:", error);
      throw error;
    }
  }

  /**
   * Add ingredients from a recipe to the grocery list.
   * Merges quantities if the same ingredient (name + unit + recipeId) already exists.
   */
  static async addRecipeItems(
    userId: string,
    request: AddRecipeItemsRequest
  ): Promise<void> {
    try {
      const {recipeId, recipeName, recipeThumbnail, ingredients} = request;
      const now = new Date().toISOString();

      // Filter selected ingredients
      const toAdd = ingredients.filter((i) => i.selected !== false);
      if (toAdd.length === 0) return;

      await this.getRef(userId).transaction((currentData) => {
        const items = (currentData || {}) as {[key: string]: GroceryItem};

        toAdd.forEach((ing) => {
          const mergeKey = this.generateMergeKey({
            name: ing.name,
            unit: ing.unit,
            recipeId: recipeId ?? null,
          });

          // Find existing item with same merge key
          const existingId = Object.keys(items).find((id) => {
            const item = items[id];
            return this.generateMergeKey(item) === mergeKey;
          });

          if (existingId) {
            const existing = items[existingId];
            if (ing.quantity !== null && typeof ing.quantity === "number") {
              existing.quantity = (existing.quantity || 0) + ing.quantity;
            }
            existing.updatedAt = now;
            // Update thumbnail if provided and missing
            if (recipeThumbnail && !existing.recipeThumbnail) {
              existing.recipeThumbnail = recipeThumbnail;
            }
            // Unmark as completed when adding more of the same item
            existing.completed = false;
          } else {
            const newId = randomUUID();
            items[newId] = {
              id: newId,
              name: ing.name,
              quantity: ing.quantity ?? null,
              unit: ing.unit,
              category: ing.category ?? null,
              recipeId: recipeId ?? null,
              recipeName: recipeName ?? null,
              recipeThumbnail: recipeThumbnail ?? null,
              completed: false,
              createdAt: now,
              updatedAt: now,
            };
          }
        });

        return items;
      });

      logger.info(
        `Added ${toAdd.length} items from recipe "${recipeName}" for user ${userId}`
      );
    } catch (error) {
      logger.error("Error adding recipe items to grocery list:", error);
      throw error;
    }
  }

  /**
   * Add a single manual item to the grocery list.
   */
  static async addManualItem(
    userId: string,
    name: string,
    quantity: number | null,
    unit: string
  ): Promise<GroceryItem> {
    try {
      const now = new Date().toISOString();
      const mergeKey = this.generateMergeKey({name, unit, recipeId: null});

      let resultItem: GroceryItem | null = null;

      await this.getRef(userId).transaction((currentData) => {
        const items = (currentData || {}) as {[key: string]: GroceryItem};

        const existingId = Object.keys(items).find((id) => {
          const item = items[id];
          return !item.recipeId && this.generateMergeKey(item) === mergeKey;
        });

        if (existingId) {
          const existing = items[existingId];
          if (quantity !== null && typeof quantity === "number") {
            existing.quantity = (existing.quantity || 0) + quantity;
          }
          existing.updatedAt = now;
          existing.completed = false;
          resultItem = existing;
        } else {
          const newId = randomUUID();
          const newItem: GroceryItem = {
            id: newId,
            name,
            quantity,
            unit,
            category: null,
            recipeId: null,
            recipeName: null,
            recipeThumbnail: null,
            completed: false,
            createdAt: now,
            updatedAt: now,
          };
          items[newId] = newItem;
          resultItem = newItem;
        }
        return items;
      });

      return resultItem!;
    } catch (error) {
      logger.error("Error adding manual item to grocery list:", error);
      throw error;
    }
  }

  /**
   * Update a grocery item's properties.
   */
  static async updateItem(
    userId: string,
    itemId: string,
    updates: UpdateGroceryItemRequest
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      const updateData = {
        ...updates,
        updatedAt: now,
      };

      await this.getRef(userId).child(itemId).update(updateData);
    } catch (error) {
      logger.error(`Error updating grocery item ${itemId}:`, error);
      throw error;
    }
  }

  /**
   * Remove an item from the grocery list.
   */
  static async removeItem(userId: string, itemId: string): Promise<void> {
    try {
      await this.getRef(userId).child(itemId).remove();
    } catch (error) {
      logger.error(`Error removing grocery item ${itemId}:`, error);
      throw error;
    }
  }
}
