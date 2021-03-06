/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {SecurityContext} from '@angular/core';

import * as cdAst from '../expression_parser/ast';
import {isPresent} from '../facade/lang';
import {Identifiers, resolveIdentifier} from '../identifiers';
import * as o from '../output/output_ast';
import {EMPTY_STATE as EMPTY_ANIMATION_STATE, LifecycleHooks, isDefaultChangeDetectionStrategy} from '../private_import_core';
import {BoundElementPropertyAst, BoundTextAst, DirectiveAst, PropertyBindingType} from '../template_parser/template_ast';
import {camelCaseToDashCase} from '../util';

import {CompileBinding} from './compile_binding';
import {CompileElement, CompileNode} from './compile_element';
import {CompileMethod} from './compile_method';
import {CompileView} from './compile_view';
import {DetectChangesVars, ViewProperties} from './constants';
import {CompileEventListener} from './event_binder';
import {NameResolver, NoLocalsNameResolver, convertCdExpressionToIr, temporaryDeclaration} from './expression_converter';

function createBindFieldExpr(exprIndex: number): o.ReadPropExpr {
  return o.THIS_EXPR.prop(`_expr_${exprIndex}`);
}

function createCurrValueExpr(exprIndex: number): o.ReadVarExpr {
  return o.variable(`currVal_${exprIndex}`);  // fix syntax highlighting: `
}

class EvalResult {
  constructor(public forceUpdate: o.Expression) {}
}

function evalCdAst(
    view: CompileView, currValExpr: o.ReadVarExpr, parsedExpression: cdAst.AST,
    context: o.Expression, nameResolver: NameResolver, method: CompileMethod,
    bindingIndex: number): EvalResult {
  var checkExpression = convertCdExpressionToIr(
      nameResolver, context, parsedExpression, DetectChangesVars.valUnwrapper, bindingIndex);
  if (!checkExpression.expression) {
    // e.g. an empty expression was given
    return null;
  }

  if (checkExpression.temporaryCount) {
    for (let i = 0; i < checkExpression.temporaryCount; i++) {
      method.addStmt(temporaryDeclaration(bindingIndex, i));
    }
  }

  if (checkExpression.needsValueUnwrapper) {
    var initValueUnwrapperStmt = DetectChangesVars.valUnwrapper.callMethod('reset', []).toStmt();
    method.addStmt(initValueUnwrapperStmt);
  }
  method.addStmt(
      currValExpr.set(checkExpression.expression).toDeclStmt(null, [o.StmtModifier.Final]));
  if (checkExpression.needsValueUnwrapper) {
    return new EvalResult(DetectChangesVars.valUnwrapper.prop('hasWrappedValue'));
  } else {
    return new EvalResult(null);
  }
}

function bind(
    view: CompileView, currValExpr: o.ReadVarExpr, fieldExpr: o.ReadPropExpr,
    parsedExpression: cdAst.AST, context: o.Expression, nameResolver: NameResolver,
    actions: o.Statement[], method: CompileMethod, bindingIndex: number) {
  const evalResult =
      evalCdAst(view, currValExpr, parsedExpression, context, nameResolver, method, bindingIndex);
  if (!evalResult) {
    return;
  }

  // private is fine here as no child view will reference the cached value...
  view.fields.push(new o.ClassField(fieldExpr.name, null, [o.StmtModifier.Private]));
  view.createMethod.addStmt(o.THIS_EXPR.prop(fieldExpr.name)
                                .set(o.importExpr(resolveIdentifier(Identifiers.UNINITIALIZED)))
                                .toStmt());

  var condition: o.Expression = o.importExpr(resolveIdentifier(Identifiers.checkBinding)).callFn([
    DetectChangesVars.throwOnChange, fieldExpr, currValExpr
  ]);
  if (evalResult.forceUpdate) {
    condition = evalResult.forceUpdate.or(condition);
  }
  method.addStmt(new o.IfStmt(
      condition,
      actions.concat([<o.Statement>o.THIS_EXPR.prop(fieldExpr.name).set(currValExpr).toStmt()])));
}

export function bindRenderText(
    boundText: BoundTextAst, compileNode: CompileNode, view: CompileView) {
  var bindingIndex = view.bindings.length;
  view.bindings.push(new CompileBinding(compileNode, boundText));
  var currValExpr = createCurrValueExpr(bindingIndex);
  var valueField = createBindFieldExpr(bindingIndex);
  view.detectChangesRenderPropertiesMethod.resetDebugInfo(compileNode.nodeIndex, boundText);

  bind(
      view, currValExpr, valueField, boundText.value, view.componentContext, view,
      [o.THIS_EXPR.prop('renderer')
           .callMethod('setText', [compileNode.renderNode, currValExpr])
           .toStmt()],
      view.detectChangesRenderPropertiesMethod, bindingIndex);
}

function bindAndWriteToRenderer(
    boundProps: BoundElementPropertyAst[], context: o.Expression, compileElement: CompileElement,
    isHostProp: boolean, eventListeners: CompileEventListener[]) {
  var view = compileElement.view;
  var renderNode = compileElement.renderNode;
  boundProps.forEach((boundProp) => {
    var bindingIndex = view.bindings.length;
    view.bindings.push(new CompileBinding(compileElement, boundProp));
    view.detectChangesRenderPropertiesMethod.resetDebugInfo(compileElement.nodeIndex, boundProp);
    var fieldExpr = createBindFieldExpr(bindingIndex);
    var currValExpr = createCurrValueExpr(bindingIndex);
    var oldRenderValue: o.Expression = sanitizedValue(boundProp, fieldExpr);
    var renderValue: o.Expression = sanitizedValue(boundProp, currValExpr);
    var updateStmts: o.Statement[] = [];
    var compileMethod = view.detectChangesRenderPropertiesMethod;
    switch (boundProp.type) {
      case PropertyBindingType.Property:
        if (view.genConfig.logBindingUpdate) {
          updateStmts.push(logBindingUpdateStmt(renderNode, boundProp.name, renderValue));
        }
        updateStmts.push(
            o.THIS_EXPR.prop('renderer')
                .callMethod(
                    'setElementProperty', [renderNode, o.literal(boundProp.name), renderValue])
                .toStmt());
        break;
      case PropertyBindingType.Attribute:
        renderValue =
            renderValue.isBlank().conditional(o.NULL_EXPR, renderValue.callMethod('toString', []));
        updateStmts.push(
            o.THIS_EXPR.prop('renderer')
                .callMethod(
                    'setElementAttribute', [renderNode, o.literal(boundProp.name), renderValue])
                .toStmt());
        break;
      case PropertyBindingType.Class:
        updateStmts.push(
            o.THIS_EXPR.prop('renderer')
                .callMethod('setElementClass', [renderNode, o.literal(boundProp.name), renderValue])
                .toStmt());
        break;
      case PropertyBindingType.Style:
        var strValue: o.Expression = renderValue.callMethod('toString', []);
        if (isPresent(boundProp.unit)) {
          strValue = strValue.plus(o.literal(boundProp.unit));
        }

        renderValue = renderValue.isBlank().conditional(o.NULL_EXPR, strValue);
        updateStmts.push(
            o.THIS_EXPR.prop('renderer')
                .callMethod('setElementStyle', [renderNode, o.literal(boundProp.name), renderValue])
                .toStmt());
        break;
      case PropertyBindingType.Animation:
        compileMethod = view.animationBindingsMethod;
        const detachStmts: o.Statement[] = [];

        const animationName = boundProp.name;
        const targetViewExpr: o.Expression =
            isHostProp ? compileElement.appElement.prop('componentView') : o.THIS_EXPR;

        const animationFnExpr =
            targetViewExpr.prop('componentType').prop('animations').key(o.literal(animationName));

        // it's important to normalize the void value as `void` explicitly
        // so that the styles data can be obtained from the stringmap
        const emptyStateValue = o.literal(EMPTY_ANIMATION_STATE);
        const unitializedValue = o.importExpr(resolveIdentifier(Identifiers.UNINITIALIZED));
        const animationTransitionVar = o.variable('animationTransition_' + animationName);

        updateStmts.push(
            animationTransitionVar
                .set(animationFnExpr.callFn([
                  o.THIS_EXPR, renderNode, oldRenderValue.equals(unitializedValue)
                                               .conditional(emptyStateValue, oldRenderValue),
                  renderValue.equals(unitializedValue).conditional(emptyStateValue, renderValue)
                ]))
                .toDeclStmt());

        detachStmts.push(animationTransitionVar
                             .set(animationFnExpr.callFn(
                                 [o.THIS_EXPR, renderNode, oldRenderValue, emptyStateValue]))
                             .toDeclStmt());

        eventListeners.forEach(listener => {
          if (listener.isAnimation && listener.eventName === animationName) {
            let animationStmt = listener.listenToAnimation(animationTransitionVar);
            updateStmts.push(animationStmt);
            detachStmts.push(animationStmt);
          }
        });

        view.detachMethod.addStmts(detachStmts);

        break;
    }

    bind(
        view, currValExpr, fieldExpr, boundProp.value, context,
        isHostProp ? new NoLocalsNameResolver(view) : view, updateStmts, compileMethod,
        view.bindings.length);
  });
}

function sanitizedValue(
    boundProp: BoundElementPropertyAst, renderValue: o.Expression): o.Expression {
  let enumValue: string;
  switch (boundProp.securityContext) {
    case SecurityContext.NONE:
      return renderValue;  // No sanitization needed.
    case SecurityContext.HTML:
      enumValue = 'HTML';
      break;
    case SecurityContext.STYLE:
      enumValue = 'STYLE';
      break;
    case SecurityContext.SCRIPT:
      enumValue = 'SCRIPT';
      break;
    case SecurityContext.URL:
      enumValue = 'URL';
      break;
    case SecurityContext.RESOURCE_URL:
      enumValue = 'RESOURCE_URL';
      break;
    default:
      throw new Error(`internal error, unexpected SecurityContext ${boundProp.securityContext}.`);
  }
  let ctx = ViewProperties.viewUtils.prop('sanitizer');
  let args =
      [o.importExpr(resolveIdentifier(Identifiers.SecurityContext)).prop(enumValue), renderValue];
  return ctx.callMethod('sanitize', args);
}

export function bindRenderInputs(
    boundProps: BoundElementPropertyAst[], compileElement: CompileElement,
    eventListeners: CompileEventListener[]): void {
  bindAndWriteToRenderer(
      boundProps, compileElement.view.componentContext, compileElement, false, eventListeners);
}

export function bindDirectiveHostProps(
    directiveAst: DirectiveAst, directiveInstance: o.Expression, compileElement: CompileElement,
    eventListeners: CompileEventListener[]): void {
  bindAndWriteToRenderer(
      directiveAst.hostProperties, directiveInstance, compileElement, true, eventListeners);
}

export function bindDirectiveInputs(
    directiveAst: DirectiveAst, directiveWrapperInstance: o.Expression,
    compileElement: CompileElement) {
  var view = compileElement.view;
  var detectChangesInInputsMethod = view.detectChangesInInputsMethod;
  detectChangesInInputsMethod.resetDebugInfo(compileElement.nodeIndex, compileElement.sourceAst);

  directiveAst.inputs.forEach((input) => {
    var bindingIndex = view.bindings.length;
    view.bindings.push(new CompileBinding(compileElement, input));
    detectChangesInInputsMethod.resetDebugInfo(compileElement.nodeIndex, input);
    var currValExpr = createCurrValueExpr(bindingIndex);
    const evalResult = evalCdAst(
        view, currValExpr, input.value, view.componentContext, view, detectChangesInInputsMethod,
        bindingIndex);
    if (!evalResult) {
      return;
    }
    detectChangesInInputsMethod.addStmt(directiveWrapperInstance
                                            .callMethod(
                                                `check_${input.directiveName}`,
                                                [
                                                  currValExpr, DetectChangesVars.throwOnChange,
                                                  evalResult.forceUpdate || o.literal(false)
                                                ])
                                            .toStmt());
  });
  var isOnPushComp = directiveAst.directive.isComponent &&
      !isDefaultChangeDetectionStrategy(directiveAst.directive.changeDetection);
  let directiveDetectChangesExpr = directiveWrapperInstance.callMethod(
      'detectChangesInternal',
      [o.THIS_EXPR, compileElement.renderNode, DetectChangesVars.throwOnChange]);
  const directiveDetectChangesStmt = isOnPushComp ?
      new o.IfStmt(directiveDetectChangesExpr, [compileElement.appElement.prop('componentView')
                                                    .callMethod('markAsCheckOnce', [])
                                                    .toStmt()]) :
      directiveDetectChangesExpr.toStmt();
  detectChangesInInputsMethod.addStmt(directiveDetectChangesStmt);
}

function logBindingUpdateStmt(
    renderNode: o.Expression, propName: string, value: o.Expression): o.Statement {
  return o.importExpr(resolveIdentifier(Identifiers.setBindingDebugInfo))
      .callFn([o.THIS_EXPR.prop('renderer'), renderNode, o.literal(propName), value])
      .toStmt();
}
