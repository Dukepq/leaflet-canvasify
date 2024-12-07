export type CanvasLayerOptions = {
  addBackground?: boolean;
};

export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

export type ExtendedMarker = L.Marker & {
  image?: HTMLImageElement;
  _leaflet_id?: string;
  layerName?: string | undefined;
  indicators?: string[];
};

export type ExtendedMarkerOptions = L.MarkerOptions & {
  layerName?: string | undefined;
};

export type RBushBox = {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
  marker: ExtendedMarker;
};
