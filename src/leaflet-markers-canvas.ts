import L from "leaflet";
import RBush from "rbush";

import {
  CanvasLayerOptions,
  ExtendedMarker,
  ExtendedMarkerOptions,
  RBushBox,
  WithRequired,
} from "./types";

class CanvasLayer extends L.Layer {
  private _canvas: HTMLCanvasElement | null = null;
  private _ctx: CanvasRenderingContext2D | null = null;
  private _layers: { [key: number]: ExtendedMarker } = {};
  private _markersTree = new RBush<RBushBox>();
  private _positionsTree = new RBush<RBushBox>();
  private _previousCursorStyle = "";
  private _icons: Record<
    string,
    {
      isLoaded: boolean;
      image: HTMLImageElement;
      elements: { marker: ExtendedMarker; x: number; y: number }[];
      hasErrored?: boolean;
    }
  > = {};
  private _mouseOverMarker: ExtendedMarker | null = null;
  private _colorMap: Record<string, string> = {};
  options: Omit<L.LayerOptions, "attribution"> & CanvasLayerOptions;

  constructor(
    options?: Omit<L.LayerOptions, "attribution"> & CanvasLayerOptions
  ) {
    super(options);
    this.options = {
      pane: "overlayPane",
      addBackground: false,
      ...options,
    };
  }

  getBounds() {
    const initMarker = this._layers[0]?.getLatLng(); // satisfies LatLngBounds type
    const bounds = new L.LatLngBounds(initMarker, initMarker);

    for (let layerId in this._layers) {
      const marker = this._layers[layerId];
      bounds.extend(marker.getLatLng());
    }

    return bounds;
  }

  onAdd(map: L.Map & { _zoomAnimated: boolean }) {
    if (!(map instanceof L.Map)) {
      throw new Error("ERROR: Provided map is not an instance of leaflet Map");
    }

    this._map = map;
    this._initCanvas();

    const overlayPane = this.getPane(this.options.pane);
    if (!overlayPane) {
      throw new Error(`ERROR: could not find pane ${this.options.pane}`);
    }
    overlayPane.appendChild(this._canvas!);

    map.on("moveend", this._reset, this);
    map.on("resize", this._reset, this);

    map.on("click", this._fire, this);
    map.on("mousemove", this._fire, this);

    if (map._zoomAnimated) {
      map.on("zoomanim", this._animateZoom, this);
    }

    return this;
  }

  onRemove(map: L.Map & { _zoomAnimated: boolean }) {
    if (this._canvas) {
      L.DomUtil.remove(this._canvas);
    }

    map.off("moveend", this._reset, this);
    map.off("resize", this._reset, this);

    map.off("click", this._fire, this);
    map.off("mousemove", this._fire, this);

    if (map._zoomAnimated) {
      map.off("zoomanim", this._animateZoom, this);
    }
    return this;
  }

  clear() {
    this._positionsTree = new RBush();
    this._markersTree = new RBush();
    this._layers = {};
    this.redraw(true);
  }

  removeMarker(marker: ExtendedMarker) {
    if (!this._map) return;

    const latLng = marker.getLatLng();
    const isVisible = this._map.getBounds().contains(latLng);

    const positionBox = {
      minX: latLng.lng,
      minY: latLng.lat,
      maxX: latLng.lng,
      maxY: latLng.lat,
      marker,
    };

    this._positionsTree.remove(positionBox, (a: RBushBox, b: RBushBox) => {
      return a.marker._leaflet_id === b.marker._leaflet_id;
    });

    if (isVisible) {
      this.redraw(true);
    }
  }

  removeMarkers(markers: ExtendedMarker[]) {
    if (!this._map) return;

    let hasChanged = false;

    for (let marker of markers) {
      const latLng = marker.getLatLng();
      const isVisible = this._map.getBounds().contains(latLng);

      const positionBox = {
        minX: latLng.lng,
        minY: latLng.lat,
        maxX: latLng.lng,
        maxY: latLng.lat,
        marker,
      };

      this._positionsTree.remove(positionBox, (a: RBushBox, b: RBushBox) => {
        return a.marker._leaflet_id === b.marker._leaflet_id;
      });

      if (isVisible) {
        hasChanged = true;
      }
    }

    if (hasChanged) {
      this.redraw(true);
    }
  }

  addMarker(marker: ExtendedMarker) {
    if (marker.options.pane !== "markerPane" || !marker.options.icon) {
      console.error("This is not a marker", marker);
      return { markerBox: null, positionBox: null, isVisible: null };
    }
    if (!this._map) {
      return { markerBox: null, positionBox: null, isVisible: null };
    }

    // @ts-expect-error
    marker._map = this._map;
    L.Util.stamp(marker);

    const latLng = marker.getLatLng();
    const isVisible = this._map.getBounds().contains(latLng);
    const { x, y } = this._map.latLngToContainerPoint(latLng);

    const iconOptions = marker.options.icon.options;

    const iconAnchor = iconOptions.iconAnchor as [number, number];
    const iconSize = iconOptions.iconSize as [number, number];

    if (!iconAnchor || !iconSize) {
      throw new Error(
        "ERROR: One or more icon options properties are undefined. Please ensure you have defined the icon anchor and icon size."
      );
    }

    const markerBox = {
      minX: x - iconAnchor[0],
      minY: y - iconAnchor[1],
      maxX: x + iconSize[0] - iconAnchor[0],
      maxY: y + iconSize[1] - iconAnchor[1],
      marker,
    };

    const positionBox = {
      minX: latLng.lng,
      minY: latLng.lat,
      maxX: latLng.lng,
      maxY: latLng.lat,
      marker,
    };

    if (isVisible) {
      this._drawMarker(marker, { x, y });
    }

    //@ts-expect-error
    this._layers[marker._leaflet_id] = marker;

    return { markerBox, positionBox, isVisible };
  }

  addMarkers(markers: ExtendedMarker[]) {
    const markerBoxes: RBushBox[] = [];
    const positionBoxes: RBushBox[] = [];

    for (let marker of markers) {
      const { markerBox, positionBox, isVisible } = this.addMarker(marker);

      if (markerBox && isVisible) {
        markerBoxes.push(markerBox);
      }

      if (positionBox) {
        positionBoxes.push(positionBox);
      }
    }

    this._markersTree.load(markerBoxes);
    this._positionsTree.load(positionBoxes);
  }

  private _drawMarker(
    marker: ExtendedMarker,
    { x, y }: { x: number; y: number }
  ) {
    const iconUrl = marker.options.icon?.options.iconUrl;

    if (typeof iconUrl === "undefined") {
      throw new Error(
        "ERROR: The icon or its url are undefined. Please ensure that the icon is properly configured and provide a valid url."
      );
    }

    if (marker.image) {
      if (this._icons[iconUrl]?.hasErrored) return;
      this._drawImage(marker, { x, y });
    } else if (this._icons[iconUrl]) {
      if (this._icons[iconUrl]?.hasErrored) return;

      marker.image = this._icons[iconUrl].image;

      if (this._icons[iconUrl].isLoaded) {
        this._drawImage(marker, { x, y });
      } else {
        this._icons[iconUrl].elements.push({ marker, x, y });
      }
    } else {
      const image = new Image();
      image.src = iconUrl;
      marker.image = image;

      this._icons[iconUrl] = {
        image,
        isLoaded: false,
        elements: [{ marker, x, y }],
      };

      image.onload = () => {
        this._icons[iconUrl].isLoaded = true;

        for (let { marker } of this._icons[iconUrl].elements) {
          /*
          We must recalculate the position because between drawing being queued
          and the onload event firing the map position could have changed.
          */
          const latLng = marker.getLatLng();
          const { x, y } = this._map.latLngToContainerPoint(latLng);
          this._drawImage(marker, { x, y });
        }
      };
      image.onerror = () => {
        this._icons[iconUrl].hasErrored = true;
        console.error(
          `ERROR: image with source ${image.src} could not be loaded. Please ensure the provided src matches the image location.`
        );
      };
    }
  }

  getAllMarkers() {
    return this._layers;
  }

  private _drawImage(
    marker: ExtendedMarker,
    { x, y }: { x: number; y: number }
  ) {
    const iconOptions = marker.options.icon?.options;
    if (!iconOptions) {
      throw new Error(
        "ERROR: Marker icon options are undefined. Please ensure that the icon is properly configured."
      );
    }

    const iconAnchor = iconOptions.iconAnchor as [number, number] | undefined;
    const iconSize = iconOptions.iconSize as [number, number] | undefined;
    if (
      typeof iconAnchor === "undefined" ||
      typeof iconSize === "undefined" ||
      typeof marker.image === "undefined"
    ) {
      throw new Error(
        "ERROR: One or more icon options properties are undefined. Please ensure you have defined the icon anchor, icon size and have provided a valid image."
      );
    }

    this._ctx!.save();
    this._ctx!.translate(x, y);

    if (this.options.addBackground) {
      const imgSrc = marker.image.src;
      let color = this._colorMap[imgSrc];
      if (!color) {
        color = this._generateDynamicHexcode(imgSrc);
        this._colorMap[imgSrc] = color;
      }

      this._ctx!.fillStyle = "#00000033";
      this._ctx!.strokeStyle = color;
      this._ctx!.lineWidth = 1;
      this._ctx!.beginPath();
      this._ctx!.arc(0, 0, iconSize[0] / 1.5, 0, 360);
      this._ctx!.fill();
      this._ctx!.stroke();
      this._ctx!.closePath();
    }

    this._ctx!.drawImage(
      marker.image,
      -iconAnchor[0],
      -iconAnchor[1],
      iconSize[0],
      iconSize[1]
    );

    const radius = Math.floor(iconSize[0] / 6 + 1);

    if (marker.indicators) {
      marker.indicators.forEach((color, idx) => {
        const row = Math.floor(idx / 5);
        const col = idx % 5;

        const posX = iconSize[0] / 2 + row * (radius * 2 + 1);
        const posY = -iconSize[1] / 2 + (col * (radius * 2 + 1)) / 2;
        this._ctx!.fillStyle = color;
        this._ctx!.strokeStyle = "black";
        this._ctx!.beginPath();
        this._ctx!.arc(posX, posY, radius, 0, 360);
        this._ctx!.fill();
        this._ctx!.stroke();
        this._ctx!.closePath();
      });
    }

    this._ctx!.restore();
  }

  private _generateDynamicHexcode(strValue: string): string {
    let hash = 0;
    strValue.split("").forEach((char) => {
      hash = char.charCodeAt(0) + ((hash << 5) - hash);
    });
    let colour = "#";
    for (let i = 0; i < 3; i++) {
      const value = (hash >> (i * 8)) & 0xff;
      colour += value.toString(16).padStart(2, "0");
    }
    return colour;
  }

  redraw(clear?: boolean) {
    if (!this._map) return;

    if (!this._positionsTree) {
      return;
    }

    if (clear && this._ctx && this._canvas) {
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }

    const mapBounds = this._map.getBounds();
    const mapBoundsBox = {
      minX: mapBounds.getWest(),
      minY: mapBounds.getSouth(),
      maxX: mapBounds.getEast(),
      maxY: mapBounds.getNorth(),
    };

    const markers: RBushBox[] = [];

    for (const { marker } of this._positionsTree.search(mapBoundsBox)) {
      const latLng = marker.getLatLng();
      const { x, y } = this._map.latLngToContainerPoint(latLng);

      let iconOptions = marker.options.icon?.options;
      if (!iconOptions) {
        throw new Error(
          "ERROR: Marker icon or its options are undefined. Please ensure that the icon is properly configured."
        );
      }

      const iconSize = iconOptions.iconSize as [number, number] | undefined;
      const iconAnchor = iconOptions.iconAnchor as [number, number] | undefined;

      if (!iconSize || !iconAnchor) {
        throw new Error(
          "ERROR: One or more icon options properties are undefined. Please ensure you have defined the icon anchor and icon size."
        );
      }

      const markerBox = {
        minX: x - iconAnchor[0],
        minY: y - iconAnchor[1],
        maxX: x + iconSize[0] - iconAnchor[0],
        maxY: y + iconSize[1] - iconAnchor[1],
        marker,
      };

      markers.push(markerBox);
      this._drawMarker(marker, { x, y });
    }

    this._markersTree.clear();
    this._markersTree.load(markers);
  }

  private _initCanvas() {
    const { x, y } = this._map.getSize();
    const isAnimated = this._map.options.zoomAnimation && L.Browser.any3d;
    this._canvas = L.DomUtil.create(
      "canvas",
      "leaflet-layer marker-canvas-layer"
    );
    this._canvas.width = x;
    this._canvas.height = y;
    this._ctx = this._canvas.getContext("2d");

    // ensure pane is always attached to the top left
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);

    L.DomUtil.addClass(
      this._canvas,
      `leaflet-zoom-${isAnimated ? "animated" : "hide"}`
    );
  }

  private _fire(event: L.LeafletMouseEvent) {
    if (!this._map) return;

    const { x, y } = event.containerPoint;
    const markers = this._markersTree.search({
      minX: x,
      minY: y,
      maxX: x,
      maxY: y,
    });

    if (markers && markers.length > 0) {
      const marker = markers[0].marker;

      if (event.type === "click") {
        if (marker.listens("click")) {
          marker.fire("click");
        }
      }

      if (event.type === "mousemove") {
        if (this._mouseOverMarker && this._mouseOverMarker !== marker) {
          if (this._mouseOverMarker.listens("mouseout")) {
            this._mouseOverMarker.fire("mouseout");
          }
        }
        if (!this._mouseOverMarker) {
          // only runs when the mouse goes from hovering no markers, to hovering any marker
          const container = this._map.getContainer();
          this._previousCursorStyle = container.style.cursor;
          container.style.cursor = "pointer";
        }
        if (this._mouseOverMarker !== marker) {
          // on hovered marker change
          this._mouseOverMarker = marker;
          if (marker.listens("mouseover")) {
            marker.fire("mouseover");
          }
        }
      }
    } else {
      // if mouse not hovering any markers
      if (event.type === "mousemove" && this._mouseOverMarker) {
        // on hover end
        this._map.getContainer().style.cursor = this._previousCursorStyle;

        if (this._mouseOverMarker.listens("mouseout")) {
          this._mouseOverMarker.fire("mouseout");
        }

        this._mouseOverMarker = null;
      }
    }
  }

  private _reset() {
    if (!this._canvas) return;

    this._canvas.width = window.innerWidth;
    this._canvas.height = window.innerHeight;

    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);

    this.redraw(true);
  }

  private _animateZoom(event: L.ZoomAnimEvent) {
    const mapContainingPrivateMethod = this._map as L.Map & {
      _latLngBoundsToNewLayerBounds: Function;
    };

    const scale = this._map.getZoomScale(event.zoom);
    const offset: L.Point =
      mapContainingPrivateMethod._latLngBoundsToNewLayerBounds(
        this._map.getBounds(),
        event.zoom,
        event.center
      ).min;

    L.DomUtil.setTransform(this._canvas!, offset, scale);
  }
}

const createIcon = (
  options: L.IconOptions & { iconSize: [number, number] }
) => {
  const [width, height] = options.iconSize;

  if (!options.iconAnchor) {
    options.iconAnchor = [width / 2, height / 2];
  }

  return L.icon(options);
};

const createMarker = (
  position: L.LatLngExpression,
  options: WithRequired<ExtendedMarkerOptions, "icon">
): ExtendedMarker => {
  const { layerName, ...baseOptions } = options;
  const marker: ExtendedMarker = L.marker(position, baseOptions);
  marker.layerName = layerName;
  return marker;
};

export { CanvasLayer, createIcon, createMarker };
