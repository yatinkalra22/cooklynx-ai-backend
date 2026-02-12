/**
 * Grocery List Types
 */

export interface GroceryItem {
  id: string;
  name: string;
  quantity: number | null;
  unit: string;
  category: string | null;
  recipeId: string | null;
  recipeName: string | null;
  recipeThumbnail: string | null;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroceryList {
  userId: string;
  items: {[itemId: string]: GroceryItem};
  updatedAt: string;
}

export interface RecipeGroup {
  recipeId?: string;
  recipeName: string;
  recipeThumbnail?: string;
  items: GroceryItem[];
  totalItems: number;
  completedItems: number;
}

export interface UnassignedGroup {
  items: GroceryItem[];
  totalItems: number;
  completedItems: number;
}

export interface AddRecipeItemsRequest {
  recipeId?: string;
  recipeName: string;
  recipeThumbnail?: string;
  ingredients: {
    name: string;
    quantity: number | null;
    unit: string;
    category?: string;
    selected?: boolean;
  }[];
}

export interface AddManualItemRequest {
  name: string;
  quantity: number | null;
  unit: string;
}

export interface UpdateGroceryItemRequest {
  quantity?: number | null;
  unit?: string;
  completed?: boolean;
}

export interface GroceryListResponse {
  items: GroceryItem[];
}

export interface GroupedGroceryListResponse {
  groups: RecipeGroup[];
  unassigned: UnassignedGroup;
}
