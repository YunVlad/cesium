import defined from "../Core/defined.js";
import Event from "../Core/Event.js";
import EventHelper from "../Core/EventHelper.js";
import JulianDate from "../Core/JulianDate.js";
import Property from "./Property.js";

/**
 * A {@link Property} whose value is an array whose items are the computed value
 * of other property instances.
 *
 * @alias PropertyArray
 * @constructor
 *
 * @param {Property[]} [value] An array of Property instances.
 */
function PropertyArray(value) {
  this._value = undefined;
  this._definitionChanged = new Event();
  this._eventHelper = new EventHelper();
  this.setValue(value);
}

Object.defineProperties(PropertyArray.prototype, {
  /**
   * Gets a value indicating if this property is constant.  This property
   * is considered constant if all property items in the array are constant.
   * @memberof PropertyArray.prototype
   *
   * @type {boolean}
   * @readonly
   */
  isConstant: {
    get: function () {
      const value = this._value;
      if (!defined(value)) {
        return true;
      }
      const length = value.length;
      for (let i = 0; i < length; i++) {
        if (!Property.isConstant(value[i])) {
          return false;
        }
      }
      return true;
    },
  },
  /**
   * Gets the event that is raised whenever the definition of this property changes.
   * The definition is changed whenever setValue is called with data different
   * than the current value or one of the properties in the array also changes.
   * @memberof PropertyArray.prototype
   *
   * @type {Event}
   * @readonly
   */
  definitionChanged: {
    get: function () {
      return this._definitionChanged;
    },
  },
});

const timeScratch = new JulianDate();

/**
 * Gets the value of the property.
 *
 * @param {JulianDate} [time=JulianDate.now()] The time for which to retrieve the value. If omitted, the current system time is used.
 * @param {Object[]} [result] The object to store the value into, if omitted, a new instance is created and returned.
 * @returns {Object[]} The modified result parameter, which is an array of values produced by evaluating each of the contained properties at the given time or a new instance if the result parameter was not supplied.
 */
PropertyArray.prototype.getValue = function (time, result) {
  if (!defined(time)) {
    time = JulianDate.now(timeScratch);
  }

  const value = this._value;
  if (!defined(value)) {
    return undefined;
  }

  const length = value.length;
  if (!defined(result)) {
    result = new Array(length);
  }
  let i = 0;
  let x = 0;
  while (i < length) {
    const property = this._value[i];
    const itemValue = property.getValue(time, result[i]);
    if (defined(itemValue)) {
      result[x] = itemValue;
      x++;
    }
    i++;
  }
  result.length = x;
  return result;
};

/**
 * Sets the value of the property.
 *
 * @param {Property[]} value An array of Property instances.
 */
PropertyArray.prototype.setValue = function (value) {
  const eventHelper = this._eventHelper;
  eventHelper.removeAll();

  if (defined(value)) {
    this._value = value.slice();
    const length = value.length;
    for (let i = 0; i < length; i++) {
      const property = value[i];
      if (defined(property)) {
        eventHelper.add(
          property.definitionChanged,
          PropertyArray.prototype._raiseDefinitionChanged,
          this,
        );
      }
    }
  } else {
    this._value = undefined;
  }
  this._definitionChanged.raiseEvent(this);
};

/**
 * Compares this property to the provided property and returns
 * <code>true</code> if they are equal, <code>false</code> otherwise.
 *
 * @param {Property} [other] The other property.
 * @returns {boolean} <code>true</code> if left and right are equal, <code>false</code> otherwise.
 */
PropertyArray.prototype.equals = function (other) {
  return (
    this === other || //
    (other instanceof PropertyArray && //
      Property.arrayEquals(this._value, other._value))
  );
};

PropertyArray.prototype._raiseDefinitionChanged = function () {
  this._definitionChanged.raiseEvent(this);
};
export default PropertyArray;
