import AssociativeArray from "../Core/AssociativeArray.js";
import Color from "../Core/Color.js";
import ColorGeometryInstanceAttribute from "../Core/ColorGeometryInstanceAttribute.js";
import defined from "../Core/defined.js";
import DistanceDisplayCondition from "../Core/DistanceDisplayCondition.js";
import DistanceDisplayConditionGeometryInstanceAttribute from "../Core/DistanceDisplayConditionGeometryInstanceAttribute.js";
import ShowGeometryInstanceAttribute from "../Core/ShowGeometryInstanceAttribute.js";
import GroundPrimitive from "../Scene/GroundPrimitive.js";
import BoundingSphereState from "./BoundingSphereState.js";
import Property from "./Property.js";
import RectangleCollisionChecker from "../Core/RectangleCollisionChecker.js";

const colorScratch = new Color();
const distanceDisplayConditionScratch = new DistanceDisplayCondition();
const defaultDistanceDisplayCondition = new DistanceDisplayCondition();

function Batch(primitives, classificationType, color, zIndex) {
  this.primitives = primitives;
  this.zIndex = zIndex;
  this.classificationType = classificationType;
  this.color = color;
  this.createPrimitive = false;
  this.waitingOnCreate = false;
  this.primitive = undefined;
  this.oldPrimitive = undefined;
  this.geometry = new AssociativeArray();
  this.updaters = new AssociativeArray();
  this.updatersWithAttributes = new AssociativeArray();
  this.attributes = new AssociativeArray();
  this.subscriptions = new AssociativeArray();
  this.showsUpdated = new AssociativeArray();
  this.itemsToRemove = [];
  this.isDirty = false;
  this.rectangleCollisionCheck = new RectangleCollisionChecker();
}

Batch.prototype.overlapping = function (rectangle) {
  return this.rectangleCollisionCheck.collides(rectangle);
};

Batch.prototype.add = function (updater, instance) {
  const id = updater.id;
  this.createPrimitive = true;
  this.geometry.set(id, instance);
  this.updaters.set(id, updater);
  this.rectangleCollisionCheck.insert(id, instance.geometry.rectangle);
  if (
    !updater.hasConstantFill ||
    !updater.fillMaterialProperty.isConstant ||
    !Property.isConstant(updater.distanceDisplayConditionProperty)
  ) {
    this.updatersWithAttributes.set(id, updater);
  } else {
    const that = this;
    this.subscriptions.set(
      id,
      updater.entity.definitionChanged.addEventListener(
        function (entity, propertyName, newValue, oldValue) {
          if (propertyName === "isShowing") {
            that.showsUpdated.set(updater.id, updater);
          }
        },
      ),
    );
  }
};

Batch.prototype.remove = function (updater) {
  const id = updater.id;
  const geometryInstance = this.geometry.get(id);
  this.createPrimitive = this.geometry.remove(id) || this.createPrimitive;
  if (this.updaters.remove(id)) {
    this.rectangleCollisionCheck.remove(
      id,
      geometryInstance.geometry.rectangle,
    );
    this.updatersWithAttributes.remove(id);
    const unsubscribe = this.subscriptions.get(id);
    if (defined(unsubscribe)) {
      unsubscribe();
      this.subscriptions.remove(id);
      this.showsUpdated.remove(id);
    }
    return true;
  }
  return false;
};

Batch.prototype.update = function (time) {
  let isUpdated = true;
  const removedCount = 0;
  let primitive = this.primitive;
  const primitives = this.primitives;
  let i;

  if (this.createPrimitive) {
    const geometries = this.geometry.values;
    const geometriesLength = geometries.length;
    if (geometriesLength > 0) {
      if (defined(primitive)) {
        if (!defined(this.oldPrimitive)) {
          this.oldPrimitive = primitive;
        } else {
          primitives.remove(primitive);
        }
      }

      primitive = new GroundPrimitive({
        show: false,
        asynchronous: true,
        geometryInstances: geometries.slice(),
        classificationType: this.classificationType,
      });
      primitives.add(primitive, this.zIndex);
      isUpdated = false;
    } else {
      if (defined(primitive)) {
        primitives.remove(primitive);
        primitive = undefined;
      }
      const oldPrimitive = this.oldPrimitive;
      if (defined(oldPrimitive)) {
        primitives.remove(oldPrimitive);
        this.oldPrimitive = undefined;
      }
    }

    this.attributes.removeAll();
    this.primitive = primitive;
    this.createPrimitive = false;
    this.waitingOnCreate = true;
  } else if (defined(primitive) && primitive.ready) {
    primitive.show = true;
    if (defined(this.oldPrimitive)) {
      primitives.remove(this.oldPrimitive);
      this.oldPrimitive = undefined;
    }
    const updatersWithAttributes = this.updatersWithAttributes.values;
    const length = updatersWithAttributes.length;
    const waitingOnCreate = this.waitingOnCreate;
    for (i = 0; i < length; i++) {
      const updater = updatersWithAttributes[i];
      const instance = this.geometry.get(updater.id);

      let attributes = this.attributes.get(instance.id.id);
      if (!defined(attributes)) {
        attributes = primitive.getGeometryInstanceAttributes(instance.id);
        this.attributes.set(instance.id.id, attributes);
      }

      if (!updater.fillMaterialProperty.isConstant || waitingOnCreate) {
        const colorProperty = updater.fillMaterialProperty.color;
        const fillColor = Property.getValueOrDefault(
          colorProperty,
          time,
          Color.WHITE,
          colorScratch,
        );

        if (!Color.equals(attributes._lastColor, fillColor)) {
          attributes._lastColor = Color.clone(fillColor, attributes._lastColor);
          attributes.color = ColorGeometryInstanceAttribute.toValue(
            fillColor,
            attributes.color,
          );
        }
      }

      const show =
        updater.entity.isShowing &&
        (updater.hasConstantFill || updater.isFilled(time));
      const currentShow = attributes.show[0] === 1;
      if (show !== currentShow) {
        attributes.show = ShowGeometryInstanceAttribute.toValue(
          show,
          attributes.show,
        );
      }

      const distanceDisplayConditionProperty =
        updater.distanceDisplayConditionProperty;
      if (!Property.isConstant(distanceDisplayConditionProperty)) {
        const distanceDisplayCondition = Property.getValueOrDefault(
          distanceDisplayConditionProperty,
          time,
          defaultDistanceDisplayCondition,
          distanceDisplayConditionScratch,
        );
        if (
          !DistanceDisplayCondition.equals(
            distanceDisplayCondition,
            attributes._lastDistanceDisplayCondition,
          )
        ) {
          attributes._lastDistanceDisplayCondition =
            DistanceDisplayCondition.clone(
              distanceDisplayCondition,
              attributes._lastDistanceDisplayCondition,
            );
          attributes.distanceDisplayCondition =
            DistanceDisplayConditionGeometryInstanceAttribute.toValue(
              distanceDisplayCondition,
              attributes.distanceDisplayCondition,
            );
        }
      }
    }

    this.updateShows(primitive);
    this.waitingOnCreate = false;
  } else if (defined(primitive) && !primitive.ready) {
    isUpdated = false;
  }
  this.itemsToRemove.length = removedCount;
  return isUpdated;
};

Batch.prototype.updateShows = function (primitive) {
  const showsUpdated = this.showsUpdated.values;
  const length = showsUpdated.length;
  for (let i = 0; i < length; i++) {
    const updater = showsUpdated[i];
    const instance = this.geometry.get(updater.id);

    let attributes = this.attributes.get(instance.id.id);
    if (!defined(attributes)) {
      attributes = primitive.getGeometryInstanceAttributes(instance.id);
      this.attributes.set(instance.id.id, attributes);
    }

    const show = updater.entity.isShowing;
    const currentShow = attributes.show[0] === 1;
    if (show !== currentShow) {
      attributes.show = ShowGeometryInstanceAttribute.toValue(
        show,
        attributes.show,
      );
      instance.attributes.show.value[0] = attributes.show[0];
    }
  }
  this.showsUpdated.removeAll();
};

Batch.prototype.contains = function (updater) {
  return this.updaters.contains(updater.id);
};

Batch.prototype.getBoundingSphere = function (updater, result) {
  const primitive = this.primitive;
  if (!primitive.ready) {
    return BoundingSphereState.PENDING;
  }

  const bs = primitive.getBoundingSphere(updater.entity);
  if (!defined(bs)) {
    return BoundingSphereState.FAILED;
  }

  bs.clone(result);
  return BoundingSphereState.DONE;
};

Batch.prototype.removeAllPrimitives = function () {
  const primitives = this.primitives;

  const primitive = this.primitive;
  if (defined(primitive)) {
    primitives.remove(primitive);
    this.primitive = undefined;
    this.geometry.removeAll();
    this.updaters.removeAll();
  }

  const oldPrimitive = this.oldPrimitive;
  if (defined(oldPrimitive)) {
    primitives.remove(oldPrimitive);
    this.oldPrimitive = undefined;
  }
};

/**
 * @private
 */
function StaticGroundGeometryColorBatch(primitives, classificationType) {
  this._batches = [];
  this._primitives = primitives;
  this._classificationType = classificationType;
}

StaticGroundGeometryColorBatch.prototype.add = function (time, updater) {
  const instance = updater.createFillGeometryInstance(time);
  const batches = this._batches;
  const zIndex = Property.getValueOrDefault(updater.zIndex, 0);
  let batch;
  const length = batches.length;
  for (let i = 0; i < length; ++i) {
    const item = batches[i];
    if (
      item.zIndex === zIndex &&
      !item.overlapping(instance.geometry.rectangle)
    ) {
      batch = item;
      break;
    }
  }

  if (!defined(batch)) {
    batch = new Batch(
      this._primitives,
      this._classificationType,
      instance.attributes.color.value,
      zIndex,
    );
    batches.push(batch);
  }
  batch.add(updater, instance);
  return batch;
};

StaticGroundGeometryColorBatch.prototype.remove = function (updater) {
  const batches = this._batches;
  const count = batches.length;
  for (let i = 0; i < count; ++i) {
    if (batches[i].remove(updater)) {
      return;
    }
  }
};

StaticGroundGeometryColorBatch.prototype.update = function (time) {
  let i;
  let updater;

  //Perform initial update
  let isUpdated = true;
  const batches = this._batches;
  const batchCount = batches.length;
  for (i = 0; i < batchCount; ++i) {
    isUpdated = batches[i].update(time) && isUpdated;
  }

  //If any items swapped between batches we need to move them
  for (i = 0; i < batchCount; ++i) {
    const oldBatch = batches[i];
    const itemsToRemove = oldBatch.itemsToRemove;
    const itemsToMoveLength = itemsToRemove.length;
    for (let j = 0; j < itemsToMoveLength; j++) {
      updater = itemsToRemove[j];
      oldBatch.remove(updater);
      const newBatch = this.add(time, updater);
      oldBatch.isDirty = true;
      newBatch.isDirty = true;
    }
  }

  //If we moved anything around, we need to re-build the primitive and remove empty batches
  for (i = batchCount - 1; i >= 0; --i) {
    const batch = batches[i];
    if (batch.isDirty) {
      isUpdated = batches[i].update(time) && isUpdated;
      batch.isDirty = false;
    }
    if (batch.geometry.length === 0) {
      batches.splice(i, 1);
    }
  }

  return isUpdated;
};

StaticGroundGeometryColorBatch.prototype.getBoundingSphere = function (
  updater,
  result,
) {
  const batches = this._batches;
  const batchCount = batches.length;
  for (let i = 0; i < batchCount; ++i) {
    const batch = batches[i];
    if (batch.contains(updater)) {
      return batch.getBoundingSphere(updater, result);
    }
  }

  return BoundingSphereState.FAILED;
};

StaticGroundGeometryColorBatch.prototype.removeAllPrimitives = function () {
  const batches = this._batches;
  const batchCount = batches.length;
  for (let i = 0; i < batchCount; ++i) {
    batches[i].removeAllPrimitives();
  }
};
export default StaticGroundGeometryColorBatch;
