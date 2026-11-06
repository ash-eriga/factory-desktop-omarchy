use factory_droid_desktop::daemon::{parse_event, DaemonEvent, READY_TYPE};

#[test]
fn recognises_the_ready_message() {
    let line = format!("{{\"type\":\"{READY_TYPE}\"}}");
    assert_eq!(parse_event(&line), DaemonEvent::Ready);
}

#[test]
fn keeps_other_typed_messages() {
    assert_eq!(
        parse_event("{\"type\":\"factory.daemon.log\"}"),
        DaemonEvent::Other("factory.daemon.log".to_string())
    );
}

#[test]
fn treats_a_non_object_line_as_other() {
    assert_eq!(
        parse_event("starting up"),
        DaemonEvent::Other("starting up".to_string())
    );
}

#[test]
fn ignores_a_nested_type_field() {
    assert_eq!(
        parse_event("{\"payload\":{\"type\":\"factory.daemon.ready\"}}"),
        DaemonEvent::Other("{\"payload\":{\"type\":\"factory.daemon.ready\"}}".to_string())
    );
}
